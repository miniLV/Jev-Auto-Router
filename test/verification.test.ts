import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeAstraEligibility,
  immediateTakeover,
  newTask,
  openAstraEligibility,
  recordVerification,
  verifyTask,
} from "../src/verification.js";

function passEvidence(conditions = [{ id: "a1", condition: "parser fixed" }]) {
  return {
    conditions,
    evidence: conditions.map(c => ({ acceptance_id: c.id, kind: "test" as const, status: "pass" as const, detail_ref: `run:${c.id}` })),
  };
}

test("PASS requires every acceptance condition independently evidenced", () => {
  const result = verifyTask(passEvidence());
  assert.equal(result.verification, "PASS");
  assert.equal(result.failing.length, 0);
});

test("a model summary is not evidence: missing or insufficient evidence never yields PASS", () => {
  const result = verifyTask({ conditions: [{ id: "a1", condition: "tests green" }], evidence: [] });
  assert.equal(result.verification, "FAIL");
  assert.equal(result.failing[0].status, "insufficient");
  assert.ok(result.failing[0].detail_ref.startsWith("no-passing-evidence"));
});

test("FAIL records the specific failing items and evidence refs", () => {
  const result = verifyTask({
    conditions: [{ id: "a1", condition: "tests green" }],
    evidence: [{ acceptance_id: "a1", kind: "test", status: "fail", detail_ref: "run:vitest:3-failed" }],
  });
  assert.equal(result.verification, "FAIL");
  assert.equal(result.failing[0].detail_ref, "run:vitest:3-failed");
  assert.deepEqual(result.evidence_refs, ["run:vitest:3-failed"]);
});

test("a correction cycle is counted per failed boundary, then takeover after two", () => {
  let task = newTask("t");
  const fail = () => verifyTask({ conditions: [{ id: "x", condition: "done" }], evidence: [{ acceptance_id: "x", kind: "run", status: "fail", detail_ref: "r1" }] });

  task = recordVerification(task, fail());
  assert.equal(task.status, "running");
  assert.equal(task.correction_cycles, 1);
  assert.deepEqual(task.failure_facts, { failing_item_ids: ["x"] });

  const fail2 = () => verifyTask({ conditions: [{ id: "x", condition: "done" }], evidence: [{ acceptance_id: "x", kind: "diff", status: "fail", detail_ref: "r2" }] });
  task = recordVerification(task, fail2());
  assert.equal(task.status, "running");
  assert.equal(task.correction_cycles, 2);

  task = recordVerification(task, fail2());
  assert.equal(task.status, "taken_over");
  assert.equal(task.takeover, "correction_cycles_exhausted");
});

test("the same defect recurring takes over immediately", () => {
  let task = newTask("t");
  const fail = () => verifyTask({ conditions: [{ id: "x", condition: "done" }], evidence: [{ acceptance_id: "x", kind: "test", status: "fail", detail_ref: "r1" }] });
  task = recordVerification(task, fail());
  task = recordVerification(task, fail());
  assert.equal(task.status, "taken_over");
  assert.equal(task.takeover, "repeated_defect");
});

test("PASS clears failure facts and completes", () => {
  let task = newTask("t");
  task = recordVerification(task, verifyTask({ conditions: [{ id: "x", condition: "done" }], evidence: [] }));
  task = recordVerification(task, verifyTask(passEvidence([{ id: "x", condition: "done" }])));
  assert.equal(task.status, "completed");
  assert.equal(task.failure_facts, undefined);
});

test("immediate takeover bypasses cycle counting", () => {
  const task = immediateTakeover(newTask("t"), "permission_problem");
  assert.equal(task.status, "taken_over");
  assert.equal(task.takeover, "permission_problem");
});

test("Astra eligibility is one-shot: consumed by use, opened once", () => {
  let task = newTask("t");
  task = openAstraEligibility(task, "reasoning-blocker", "ev:1");
  assert.ok(task.astra_eligibility);
  const reopened = openAstraEligibility(task, "other", "ev:2");
  assert.equal(reopened.astra_eligibility?.evidence_ref, "ev:1");
  task = consumeAstraEligibility(task);
  assert.equal(task.astra_eligibility, undefined);
});
