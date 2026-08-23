/**
 * Icon registry — FIX-730.
 *
 * The single canonical mapping from stable semantic KEYS to lucide glyphs.
 * There is exactly one of these tables in the codebase; do not duplicate it.
 *
 * Design (FIX-730 decisions 6-9):
 *   - Server routes emit the semantic KEY they already have (sector/industry
 *     slug, gb_type, preset id, connection type, entity/group type, issue key,
 *     nav key) — never an emoji string. Renderers resolve key -> glyph HERE.
 *   - Unknown keys — including legacy emoji strings that still live in old
 *     saved-view payloads or entity_tags.display_icon — resolve to a generic
 *     fallback (Building2). A raw emoji string is NEVER rendered.
 *   - DOM / SVG surfaces render <Icon name={key} />. Canvas surfaces
 *     (ForceGraph) do NOT use this — they drop the glyph for a dot/initial.
 *
 * Only monochrome typographic glyphs are kept inline elsewhere (decision 8):
 *   ✓ ✕ ✗ ★ ⚠ ⚙ → ← ↗ ⌘ +  — those never route through this registry.
 */

import type { ComponentProps } from "react";
import {
  Building2, Landmark, Home, Scale, Megaphone, Banknote, DollarSign, Zap, Pill,
  Shield, HardHat, Laptop, Wheat, ShoppingCart, Truck, Hammer, GraduationCap,
  Vote, Eye, Sparkles, Link2, MapPin, Target, Compass, Lock, Bookmark, Save,
  Trash2, Camera, Download, Map, Clock, Hourglass, Timer, Flame, MessageCircle,
  Bot, Database, Cloud, TrendingUp, Radio, Fuel, Cigarette, Globe, Handshake,
  Repeat, Ban, User, Users, ClipboardList, ScrollText, Sprout, HeartPulse,
  Briefcase, Factory, IdCard, Umbrella, Award, Stamp, Calendar, Sun, FileText,
  Search, BarChart3, Hand, Network, Leaf, Tag, Pin, Gavel, Lightbulb,
  CircleCheck, Plane, Pickaxe, Newspaper, GitBranch, Mail, Triangle,
} from "lucide-react";

/** The component type of any lucide glyph (derived — no lucide type import). */
type IconComponent = typeof Building2;

/** Generic fallback for unknown / legacy-emoji keys. */
export const GENERIC_ICON: IconComponent = Building2;

/**
 * key -> glyph. Keys are stable slugs already carried by the data model
 * (sector/industry slugs, gb_type, preset ids, connection types, entity types,
 * issue tags, nav slugs) plus a small set of generic UI keys.
 */
export const ICON_REGISTRY: Record<string, IconComponent> = {
  // ── Industry / sector slugs ──────────────────────────────────────────────
  //
  // Every member of INDUSTRY_KEYS (./industries.ts) MUST appear in this block —
  // a missing key renders the generic Building2 fallback, which reads as "we
  // have no idea what this is" on a pill whose whole job is to say what it is.
  // icons.test.ts asserts key-completeness against INDUSTRY_KEYS, so adding a
  // vocabulary key without an icon fails the build rather than degrading
  // quietly.
  finance: Banknote,
  labor: HardHat,
  energy: Zap,
  healthcare: HeartPulse,
  // FIX-908: `pharma` was renamed to `health` in the vocabulary. The old key is
  // KEPT as an alias, not deleted — share codes, embedded graphs and cached
  // rollup rows minted before the rename still carry it, and dropping it would
  // silently downgrade those to the generic icon.
  health: HeartPulse,
  pharma: Pill,
  real_estate: Home,
  tech: Laptop,
  technology: Laptop,
  agriculture: Wheat,
  defense: Shield,
  transportation: Truck,
  transport: Truck,
  construction: Hammer,
  retail: ShoppingCart,
  retail_food: ShoppingCart,
  education: GraduationCap,
  legal: Scale,
  telecom: Radio,
  insurance: Umbrella,
  tobacco: Cigarette,
  oil_gas: Fuel,
  // FIX-908: the four new vocabulary buckets.
  utilities: Zap,
  manufacturing: Factory,
  mining: Pickaxe,
  media: Newspaper,
  // FIX-908: `lobby` is the canonical vocabulary key (1,474 rows) but only
  // `lobbying` was registered, so every lobby pill has been rendering the
  // generic Building2 fallback. Found by the new key-completeness test, not by
  // anyone looking at it — which is the argument for the test.
  lobby: Handshake,

  // ── Governing-body types ─────────────────────────────────────────────────
  legislature_upper: Landmark,
  legislature_lower: Landmark,
  legislature_unicameral: Landmark,
  executive: Landmark,
  judicial: Scale,
  committee: Users,

  // ── Entity / group types ─────────────────────────────────────────────────
  official: User,
  individual: User,
  pac: Briefcase,
  super_pac: Briefcase,
  party_committee: Landmark,
  corporation: Building2,
  organization: Building2,
  agency: Landmark,
  union: Users,
  proposal: ClipboardList,
  bill: ScrollText,
  regulation: ScrollText,
  initiative: Sprout,
  jurisdiction: Map,
  meeting: Calendar,

  // ── Connection types ─────────────────────────────────────────────────────
  donation: Banknote,
  opposition: Ban,
  appointment: Stamp,
  nomination: Award,
  oversight: Eye,
  lobbying: Handshake,
  co_sponsorship: Handshake,
  revolving_door: Repeat,
  contract_award: Banknote,

  // ── Graph preset ids ─────────────────────────────────────────────────────
  "follow-the-money": Banknote,
  "votes-and-bills": Vote,
  nominations: Award,
  "committee-power": Eye,
  "full-record": ClipboardList,
  "clean-view": Sparkles,
  "chord-sector-vote": Scale,
  "chord-subject-party": Tag,
  "chord-donor-type-party": Landmark,
  "chord-state-party": MapPin,

  // ── Issue keys ───────────────────────────────────────────────────────────
  climate: Leaf,
  economy: Briefcase,
  immigration: Globe,
  grassroots: Sprout,
  pac_heavy: Banknote,
  bipartisan: Handshake,
  consumer_protection: Shield,
  consumer: Shield,
  aviation: Plane,

  // ── Nav / section keys ───────────────────────────────────────────────────
  home: Home,
  officials: User,
  proposals: ClipboardList,
  agencies: Landmark,
  initiatives: Sprout,
  graph: Network,
  search: Search,
  dashboard: BarChart3,
  profile: Hand,
  desk: Hand,
  insights: Lightbulb,
  page: FileText,

  // ── Generic UI keys ──────────────────────────────────────────────────────
  target: Target,
  compass: Compass,
  lock: Lock,
  users: Users,
  group: Users,
  bookmark: Bookmark,
  ai: Sparkles,
  sparkles: Sparkles,
  link: Link2,
  pin: Pin,
  save: Save,
  trash: Trash2,
  camera: Camera,
  screenshot: Camera,
  download: Download,
  map: Map,
  vote: Vote,
  clock: Clock,
  deadline: Clock,
  hourglass: Hourglass,
  timer: Timer,
  fire: Flame,
  hot: Flame,
  message: MessageCircle,
  comment: MessageCircle,
  megaphone: Megaphone,
  announcement: Megaphone,
  eye: Eye,
  watch: Eye,
  doc: FileText,
  file: FileText,
  scroll: ScrollText,
  calendar: Calendar,
  robot: Bot,
  anthropic: Bot,
  database: Database,
  supabase: Database,
  cloud: Cloud,
  cloudflare: Cloud,
  mapbox: Map,
  // Platform-cost providers (FIX-1091). GitHub, Upstash and Resend have been
  // collected since FIX-1090 but had no card to appear on; Vercel was rendering
  // a literal "▲" through the emoji fallback, which is the one thing FIX-730
  // took off these surfaces.
  vercel: Triangle,
  github: GitBranch,
  upstash: Zap,
  resend: Mail,
  money: DollarSign,
  dollar: DollarSign,
  bracket: Banknote,
  sun: Sun,
  sector: Briefcase,
  location: MapPin,
  state: MapPin,
  factory: Factory,
  gavel: Gavel,
  id: IdCard,
  handshake: Handshake,
  trending: TrendingUp,
  complete: CircleCheck,
};

/** Resolve a semantic key to a lucide component (fallback = GENERIC_ICON). */
export function resolveIcon(name?: string | null): IconComponent {
  if (!name) return GENERIC_ICON;
  return ICON_REGISTRY[name] ?? GENERIC_ICON;
}

/** True when a key maps to a real registry glyph (not the fallback). */
export function hasIcon(name?: string | null): boolean {
  return !!name && name in ICON_REGISTRY;
}

/**
 * <Icon name={key} /> — resolves a semantic key to its glyph. All lucide sizing
 * / color / stroke props pass through (e.g. size, className, strokeWidth).
 * Unknown or legacy-emoji keys render the generic fallback glyph.
 */
export function Icon({
  name,
  ...props
}: { name?: string | null } & ComponentProps<IconComponent>) {
  const Cmp = resolveIcon(name);
  return <Cmp aria-hidden {...props} />;
}
