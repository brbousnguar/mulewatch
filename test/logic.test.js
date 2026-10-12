import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeLogEntries,
  normalizeCollection,
  normalizeLogEntries,
  normalizePriority,
  normalizeName,
  logMatchesTerms
} from "../dist/normalize.js";
import { enumerateDates, parseArchiveLogLines } from "../dist/archive-parse.js";
import { isEnvironmentAllowed } from "../dist/config.js";

test("normalizeCollection unwraps every Anypoint envelope shape", () => {
  assert.deepEqual(normalizeCollection([1, 2]), [1, 2]);
  assert.deepEqual(normalizeCollection({ data: [1] }), [1]);
  assert.deepEqual(normalizeCollection({ items: [2] }), [2]);
  assert.deepEqual(normalizeCollection({ applications: [3] }), [3]);
  assert.deepEqual(normalizeCollection({ apis: [4] }), [4]);
  assert.deepEqual(normalizeCollection(null), []);
});

test("normalizeLogEntries prefers log-specific envelopes", () => {
  assert.deepEqual(normalizeLogEntries({ logs: [1] }), [1]);
  assert.deepEqual(normalizeLogEntries({ content: [2] }), [2]);
  assert.deepEqual(normalizeLogEntries({ nope: [3] }), []);
});

test("normalizePriority collapses platform level spellings", () => {
  assert.equal(normalizePriority("error"), "ERROR");
  assert.equal(normalizePriority("LEVEL_FATAL"), "FATAL");
  assert.equal(normalizePriority("warn"), "WARN");
  assert.equal(normalizePriority(""), "UNKNOWN");
  assert.equal(normalizePriority("CUSTOM"), "CUSTOM");
});

test("normalizeName makes deployment names comparable", () => {
  assert.equal(normalizeName("My App"), "myapp");
  assert.equal(normalizeName("my-app"), "myapp");
  assert.equal(normalizeName("My_App "), "myapp");
});

test("logMatchesTerms is case-insensitive and matches any term", () => {
  const log = { timestamp: "", priority: "ERROR", message: "Import finished", loggerName: "", threadName: "", instanceId: "" };
  assert.equal(logMatchesTerms(log, []), true);
  assert.equal(logMatchesTerms(log, ["IMPORT"]), true);
  assert.equal(logMatchesTerms(log, ["nope", "finished"]), true);
  assert.equal(logMatchesTerms(log, ["nope"]), false);
});

test("analyzeLogEntries counts before filtering and filters on errorOnly", () => {
  const logs = [
    { priority: "INFO", message: "a", loggerName: "L1", instanceId: "i1", timestamp: "", threadName: "" },
    { priority: "ERROR", message: "boom", loggerName: "L2", instanceId: "i1", timestamp: "", threadName: "" },
    { priority: "FATAL", message: "dead", loggerName: "L2", instanceId: "i2", timestamp: "", threadName: "" }
  ];

  const all = analyzeLogEntries(logs);
  assert.equal(all.totalFetched, 3);
  assert.equal(all.totalMatched, 3);
  assert.deepEqual(all.priorityCounts, { INFO: 1, ERROR: 1, FATAL: 1 });
  assert.deepEqual(all.loggerCounts, { L1: 1, L2: 2 });
  assert.deepEqual(all.instanceCounts, { i1: 2, i2: 1 });

  const errors = analyzeLogEntries(logs, { errorOnly: true });
  // Counts still describe everything fetched, not just the matches.
  assert.equal(errors.totalFetched, 3);
  assert.equal(errors.totalMatched, 2);
  assert.deepEqual(errors.logs.map((l) => l.priority), ["ERROR", "FATAL"]);

  const searched = analyzeLogEntries(logs, { searchTerms: ["boom"] });
  assert.equal(searched.totalMatched, 1);
});

test("enumerateDates walks inclusive UTC ranges and caps at maxDays", () => {
  assert.deepEqual(enumerateDates("2026-08-09", "2026-08-09", 7), ["2026-08-09"]);
  assert.deepEqual(enumerateDates("2026-08-09", "2026-08-11", 7), [
    "2026-08-09",
    "2026-08-10",
    "2026-08-11"
  ]);
  assert.equal(enumerateDates("2026-08-01", "2026-08-31", 7).length, 7);
  // Month and year boundaries.
  assert.deepEqual(enumerateDates("2026-12-31", "2027-01-01", 7), ["2026-12-31", "2027-01-01"]);
  assert.throws(() => enumerateDates("2026-8-9", "2026-08-09", 7), /YYYY-MM-DD/);
  assert.throws(() => enumerateDates("2026-08-11", "2026-08-09", 7), /on or before/);
});

test("parseArchiveLogLines extracts timestamp, level and logger", () => {
  const text = [
    "[2026-08-09 03:14:22.117] ERROR org.mule.Foo - boom",
    "",
    "continuation line with no prefix"
  ].join("\n");

  const entries = parseArchiveLogLines(text, "replica-1");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].timestamp, "2026-08-09 03:14:22.117");
  assert.equal(entries[0].priority, "ERROR");
  assert.equal(entries[0].loggerName, "org.mule.Foo");
  assert.equal(entries[0].instanceId, "replica-1");
  // Unparseable lines are kept verbatim rather than dropped.
  assert.equal(entries[1].message, "continuation line with no prefix");
  assert.equal(entries[1].instanceId, "replica-1");
});

test("isEnvironmentAllowed defaults to open and matches id or name case-insensitively", () => {
  const open = { allowedEnvironments: [] };
  assert.equal(isEnvironmentAllowed(open, { id: "x", name: "Prod" }), true);

  const scoped = { allowedEnvironments: ["Dev", "abc-123"] };
  assert.equal(isEnvironmentAllowed(scoped, { id: "1", name: "dev" }), true);
  assert.equal(isEnvironmentAllowed(scoped, { id: "ABC-123", name: "Whatever" }), true);
  assert.equal(isEnvironmentAllowed(scoped, { id: "2", name: "Prod" }), false);
});
