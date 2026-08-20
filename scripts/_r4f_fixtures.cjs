// [R4F] 受入検査と公開反映の確認で共有する**合成フィクスチャ**。
//  実験の実データ・本文・ID・語彙は1つも含まない。
"use strict";
const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// 合成フィクスチャ。実験の実データ・本文・ID・語彙は一切持ち込まない。
// ---------------------------------------------------------------------------
function sha(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
function definitionText(pkg) {
  return JSON.stringify({
    experiment: pkg.experiment, policy: pkg.policy,
    exportTargets: pkg.exportTargets, cases: pkg.cases
  });
}
function reseal(pkg) {
  const body = JSON.parse(JSON.stringify(pkg));
  delete body.definitionSha256;
  delete body.integrity;
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}
const BASE_POLICY = {
  arms: [{ id: "A", role: "slot", label: "A" }, { id: "B", role: "slot", label: "B" }],
  maxImagesPerArm: 2, requiredImagesPerArm: 2,
  verdicts: ["accept", "hold", "reject"],
  scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
  failureCodes: ["composition", "anatomy", "other"], preferences: ["A", "B", "tie"],
  seedSupport: ["supported", "unsupported"], adoptionDecision: "not-applicable", rankImpliesAdoption: false
};
function longPrompt(tag) {
  return `合成本文 ${tag} 一行目\n合成の指示 ${tag}。`
    + "これは受入検査のための合成本文であり、実験の語彙は含まない。"
    + "長い一文の折返しと読み取り専用欄での表示を確かめるために、句読点を挟みながら十分な長さにしてある。";
}

// R4F より前に使われていた宣言の無いパッケージ(3ケース = 画像12枠)
function buildStalePackage() {
  const cases = [1, 2, 3].map((n) => {
    const a = longPrompt("SL" + n + "-A");
    const b = longPrompt("SL" + n + "-B");
    const settings = { schema: "t9_gen_settings.v1", salt: "sl-" + n };
    return {
      sourceNo: n, caseId: "SL-0" + n, baselineGenerationId: "gen-sl-p00" + n,
      role: "合成軸", species: "", reason: "合成フィクスチャ",
      batchId: "sl-batch", no: n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      arms: {
        A: { generationId: "sl-p" + n + "-A", role: "control", prompt: a, promptSha256: sha(a), treatmentApplied: false, diffSummary: "合成" },
        B: { generationId: "sl-p" + n + "-B", role: "treatment", prompt: b, promptSha256: sha(b), treatmentApplied: true, diffSummary: "合成" }
      }
    };
  });
  return reseal({
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-09T00:00:00.000Z", generatedBy: "fixture-stale",
    experiment: { experimentId: "fixture-stale-legacy", hypothesis: "合成", automaticProductionUpdate: false, seedSupported: false },
    policy: Object.assign({}, BASE_POLICY),
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-fixture-stale-ab.v1" },
    cases
  });
}

const QUEUE_KEYS = ["sequence", "caseId", "sourceNo", "slot", "rank", "armGenerationId", "promptSha256"];
function normalizedQueueText(items) {
  return JSON.stringify(items.map((i) => {
    const out = {};
    QUEUE_KEYS.forEach((k) => { out[k] = i[k]; });
    return out;
  }));
}
// 案内付きパッケージ(2ケース = 8手順)。variant を変えると定義ハッシュだけが変わる。
function buildGuidedPackage(variant) {
  const spec = [
    { n: 1, slotRoles: { A: "control", B: "treatment" }, generationOrder: ["control", "treatment"], evaluationOrder: 2 },
    { n: 2, slotRoles: { A: "treatment", B: "control" }, generationOrder: ["treatment", "control"], evaluationOrder: 1 }
  ];
  const promptFor = (n, slot) => longPrompt("GD" + variant + "-" + n + slot);
  const cases = spec.map((c) => {
    const a = promptFor(c.n, "A"), b = promptFor(c.n, "B");
    const settings = { schema: "t9_gen_settings.v1", salt: "gd-" + variant + "-" + c.n };
    return {
      sourceNo: c.n, caseId: "GD-0" + c.n, baselineGenerationId: "gen-gd-p00" + c.n,
      role: "合成軸", species: "", reason: "合成フィクスチャ",
      batchId: "gd-batch", no: c.n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      slotRoles: c.slotRoles, generationOrder: c.generationOrder, evaluationOrder: c.evaluationOrder,
      imagesPerArm: 2,
      arms: {
        A: { generationId: "gd-p" + c.n + "-A", role: c.slotRoles.A, prompt: a, promptSha256: sha(a),
             treatmentApplied: c.slotRoles.A === "treatment", diffSummary: "合成" },
        B: { generationId: "gd-p" + c.n + "-B", role: c.slotRoles.B, prompt: b, promptSha256: sha(b),
             treatmentApplied: c.slotRoles.B === "treatment", diffSummary: "合成" }
      }
    };
  });
  const items = [];
  let seq = 0;
  spec.forEach((c) => {
    const slotForRole = {};
    slotForRole[c.slotRoles.A] = "A";
    slotForRole[c.slotRoles.B] = "B";
    c.generationOrder.map((r) => slotForRole[r]).forEach((slot) => {
      [1, 2].forEach((rank) => {
        seq += 1;
        items.push({ sequence: seq, caseId: "GD-0" + c.n, sourceNo: c.n, slot, rank,
          armGenerationId: "gd-p" + c.n + "-" + slot, promptSha256: sha(promptFor(c.n, slot)) });
      });
    });
  });
  return reseal({
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-21T00:00:00.000Z", generatedBy: "fixture-guided-r4f",
    experiment: {
      experimentId: "fixture-guided-r4f",
      title: "合成 案内付き実験 " + variant,
      hypothesis: "合成",
      generationConditions: { provider: "openai", model: "合成モデルUI", seedSupport: "unsupported", imageSeed: null },
      generationExecution: {
        schemaVersion: "fixture.generation-execution.v1",
        derivedFrom: "cases[].generationOrder + cases[].slotRoles",
        itemCount: items.length,
        normalizedQueueSha256: sha(normalizedQueueText(items)),
        exposesRoleSemantics: false,
        items
      },
      automaticProductionUpdate: false, seedSupported: false
    },
    policy: Object.assign({}, BASE_POLICY),
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-fixture-guided-r4f-ab.v1" },
    cases
  });
}

// R4F より前の単一保管庫の中身。画像12件・評価12件・比較3件。
function buildStaleStore(pkg) {
  const conditions = [];
  const images = [];
  const reviews = [];
  const comparisons = [];
  pkg.cases.forEach((c) => {
    conditions.push({
      conditionId: "abcond-sl-" + c.sourceNo, experimentId: pkg.experiment.experimentId,
      caseKey: "p" + c.sourceNo, sourceNo: c.sourceNo,
      provider: "openai", model: "合成の旧モデル", seedSupport: "unsupported", imageSeed: null,
      supersedes: null, ts: "2026-08-09T01:00:00.000Z"
    });
    ["A", "B"].forEach((arm) => {
      [1, 2].forEach((rank) => {
        const imageId = "sl-p" + c.sourceNo + "-" + arm + "-img-" + rank;
        images.push({
          imageId, experimentId: pkg.experiment.experimentId, caseKey: "p" + c.sourceNo,
          sourceNo: c.sourceNo, arm, armRole: c.arms[arm].role,
          armGenerationId: c.arms[arm].generationId, baselineGenerationId: c.baselineGenerationId,
          conditionId: "abcond-sl-" + c.sourceNo, rank,
          metadata: { name: imageId + ".png", type: "image/png", size: 120 + rank,
            lastModified: 1000 + rank, sha256: sha(imageId) },
          ts: "2026-08-09T01:0" + rank + ":00.000Z"
        });
        reviews.push({
          reviewId: "abrev-" + imageId, imageId, verdict: rank === 1 ? "hold" : "accept",
          scores: { aestheticSatisfaction: 3, intentMatch: 4 }, failures: ["composition"],
          notes: "旧実験の評価 " + imageId, supersedes: null, ts: "2026-08-09T02:00:00.000Z"
        });
      });
    });
    comparisons.push({
      comparisonId: "abcmp-p" + c.sourceNo, experimentId: pkg.experiment.experimentId,
      caseKey: "p" + c.sourceNo, sourceNo: c.sourceNo,
      controlImageId: "sl-p" + c.sourceNo + "-A-img-1",
      treatmentImageId: "sl-p" + c.sourceNo + "-B-img-1",
      preference: "B", notes: "旧実験の比較 " + c.sourceNo,
      adoptionDecision: "not-applicable", supersedes: null, ts: "2026-08-09T03:00:00.000Z"
    });
  });
  return {
    pkg,
    defaultCondition: { provider: "openai", model: "合成の旧モデル", seedSupport: "unsupported", imageSeed: null },
    conditions, images, reviews,
    reviewDrafts: {}, comparisonDrafts: {}, comparisons,
    invalidations: [], exportedImageIds: [], resamplePlan: null,
    phase: null, guidedRetries: [], guidedRepairs: []
  };
}

module.exports = { sha, reseal, buildStalePackage, buildGuidedPackage, buildStaleStore, longPrompt };
