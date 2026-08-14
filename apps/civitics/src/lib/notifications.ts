/**
 * Server-side notification fan-out.
 *
 * notifyFollowers() looks up everyone following an entity, inserts an in-app
 * notification for each, and — if email_enabled — sends a Resend email.
 *
 * Meant to be called from:
 *   • cron routes (detecting new votes, new proposals)
 *   • existing flows that mutate an entity (e.g. initiative response)
 */

import { createAdminClient } from "@civitics/db";
import { renderNotificationEmail, sendEmail } from "./email";
import { fetchChunkedByIds } from "./paginate";

type EntityType = "official" | "agency";
type EventType = "official_vote" | "new_proposal" | "initiative_status";

export type NotifyFollowersInput = {
  entityType: EntityType;
  entityId: string;
  eventType: EventType;
  title: string;
  body?: string;
  link?: string;
};

export type NotifyFollowersResult = {
  followers: number;
  notified: number;
  emailsSent: number;
  emailsSkipped: number;
};

export async function notifyFollowers(
  input: NotifyFollowersInput
): Promise<NotifyFollowersResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const siteUrl =
    process.env["NEXT_PUBLIC_SITE_URL"] ?? "https://civitics.com";

  const { data: follows } = await db
    .from("user_follows")
    .select("user_id, email_enabled")
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId);

  const followerRows: Array<{ user_id: string; email_enabled: boolean }> =
    follows ?? [];

  if (followerRows.length === 0) {
    return { followers: 0, notified: 0, emailsSent: 0, emailsSkipped: 0 };
  }

  // Insert notifications in a single batch
  const rows = followerRows.map((f) => ({
    user_id:     f.user_id,
    event_type:  input.eventType,
    entity_type: input.entityType,
    entity_id:   input.entityId,
    title:       input.title,
    body:        input.body ?? null,
    link:        input.link ?? null,
  }));

  const { data: inserted, error: insertErr } = await db
    .from("notifications")
    .insert(rows)
    .select("id, user_id");

  if (insertErr) {
    return { followers: followerRows.length, notified: 0, emailsSent: 0, emailsSkipped: 0 };
  }

  // Email fan-out — only to follows with email_enabled. Look up emails in bulk.
  const emailTargets = followerRows
    .filter((f) => f.email_enabled)
    .map((f) => f.user_id);

  let emailsSent = 0;
  let emailsSkipped = 0;

  if (emailTargets.length > 0) {
    // FIX-902: chunked. `emailTargets` is every follower of this entity with
    // email enabled — the follow read above has no cap, and a widely-followed
    // official is exactly the entity whose notifications matter most. A 414
    // here returns zero users, so every email is silently skipped while the
    // in-app notifications (already inserted) look fine.
    const { rows: userRows, complete: usersComplete } = await fetchChunkedByIds<{
      id: string; email: string | null;
    }>(
      emailTargets,
      (ids) => db.from("users").select("id, email").in("id", ids),
      { label: "notify-followers:email-targets" },
    );
    if (!usersComplete) {
      console.error("[notifyFollowers] email target read incomplete — some followers not emailed");
    }
    const html = renderNotificationEmail({
      title: input.title,
      body:  input.body ?? null,
      link:  input.link ?? null,
      siteUrl,
    });

    const idsSent: string[] = [];
    for (const u of userRows) {
      if (!u.email) {
        emailsSkipped++;
        continue;
      }
      const result = await sendEmail({
        to:      u.email,
        subject: input.title,
        html,
      });
      if (result.sent) {
        emailsSent++;
        idsSent.push(u.id);
      } else {
        emailsSkipped++;
      }
    }

    if (idsSent.length > 0 && inserted) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchedNotifIds = (inserted as any[])
        .filter((n) => idsSent.includes(n.user_id))
        .map((n) => n.id);
      if (matchedNotifIds.length > 0) {
        // FIX-902: chunked. Same follower-count feeder as the read above — the
        // id list rides the URL on an UPDATE exactly as it does on a SELECT, so
        // a large fan-out left every `email_sent` flag false after the mail had
        // actually gone out.
        const { complete: markComplete } = await fetchChunkedByIds<never>(
          matchedNotifIds,
          (ids) => db.from("notifications").update({ email_sent: true }).in("id", ids),
          { label: "notify-followers:mark-email-sent" },
        );
        if (!markComplete) {
          console.error("[notifyFollowers] email_sent update incomplete — some rows may re-send");
        }
      }
    }
  }

  return {
    followers: followerRows.length,
    notified:  rows.length,
    emailsSent,
    emailsSkipped,
  };
}

/**
 * Insert a single notification for a specific user (no fan-out, no email).
 * Use when you already know the recipient and want a lightweight in-app ping.
 */
export async function createNotification(args: {
  userId: string;
  eventType: EventType;
  title: string;
  body?: string;
  link?: string;
  entityType?: EntityType;
  entityId?: string;
}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  await db.from("notifications").insert({
    user_id:     args.userId,
    event_type:  args.eventType,
    title:       args.title,
    body:        args.body ?? null,
    link:        args.link ?? null,
    entity_type: args.entityType ?? null,
    entity_id:   args.entityId ?? null,
  });
}
