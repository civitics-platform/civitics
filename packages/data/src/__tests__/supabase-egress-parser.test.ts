/**
 * FIX-α — egress device-filter guard for parsePrometheusText.
 *
 * Runs via:  packages/data run-tests.mjs  →  tsx --test
 *
 * The Platform Costs "egress" figure comes from the Prometheus counter
 * node_network_transmit_bytes_total, reported per `device=`. The parser sums
 * across matching rows, so without a device filter it would fold loopback
 * (lo) and container-bridge (docker/veth/br/cni) transmit into "egress" and
 * inflate it. Prod exposes a single device="ens5" today, so the bug is latent
 * there — these vectors pin the exclusion so it can't silently regress on a
 * tier/host that exposes virtual interfaces.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrometheusText, NETWORK_VIRTUAL_DEVICES } from "@civitics/db";

const EGRESS = "node_network_transmit_bytes_total";

// Multi-device body: only the physical NIC (ens5) is real egress.
const MULTI_DEVICE_BODY = [
  `# HELP ${EGRESS} Network device statistic transmit_bytes.`,
  `# TYPE ${EGRESS} counter`,
  `${EGRESS}{device="lo"} 5000000000`,
  `${EGRESS}{device="docker0"} 3000000000`,
  `${EGRESS}{device="veth1a2b3c"} 1000000000`,
  `${EGRESS}{device="br-9f8e7d"} 2000000000`,
  `${EGRESS}{device="cni0"} 1500000000`,
  `${EGRESS}{device="ens5"} 302792238861`,
  "",
].join("\n");

const ENS5_ONLY = 302792238861;
const ALL_DEVICES_SUM =
  5000000000 + 3000000000 + 1000000000 + 2000000000 + 1500000000 + ENS5_ONLY;

test("egress: virtual interfaces are excluded, only physical NIC is summed", () => {
  const out = parsePrometheusText(MULTI_DEVICE_BODY, [
    { name: EGRESS, labelExcludes: NETWORK_VIRTUAL_DEVICES },
  ]);
  assert.equal(out.get(EGRESS), ENS5_ONLY);
});

test("egress: without the exclude list the parser sums every device (the latent bug)", () => {
  const out = parsePrometheusText(MULTI_DEVICE_BODY, [{ name: EGRESS }]);
  assert.equal(out.get(EGRESS), ALL_DEVICES_SUM);
});

test("egress: single-device (prod-shape) body is unaffected by the exclude list", () => {
  const body = `${EGRESS}{device="ens5"} ${ENS5_ONLY}\n`;
  const out = parsePrometheusText(body, [
    { name: EGRESS, labelExcludes: NETWORK_VIRTUAL_DEVICES },
  ]);
  assert.equal(out.get(EGRESS), ENS5_ONLY);
});

test("NETWORK_VIRTUAL_DEVICES covers the known virtual/loopback interfaces", () => {
  for (const needle of [
    'device="lo"',
    'device="docker',
    'device="veth',
    'device="br',
    'device="cni',
  ]) {
    assert.ok(
      NETWORK_VIRTUAL_DEVICES.includes(needle),
      `expected NETWORK_VIRTUAL_DEVICES to exclude ${needle}`,
    );
  }
});
