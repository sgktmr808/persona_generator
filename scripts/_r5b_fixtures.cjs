// [R5B] 受入検査と公開反映の確認で共有する**合成フィクスチャ**。
//  実験の実データ・本文・ID・語彙は1つも含まない。
"use strict";
const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// 合成パッケージ(実験の実データは使わない)
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
function clone(p) { return JSON.parse(JSON.stringify(p)); }

// 選択肢は合成の語彙。実験の分類名をこの検査へ持ち込まない。
const INTENT_STATUSES = [
  { value: "fx_ok", label: "合成の選択肢イ（合っている）" },
  { value: "fx_hard", label: "合成の選択肢ロ（強すぎる）" },
  { value: "fx_soft", label: "合成の選択肢ハ（緩すぎる。長い説明を入れて折返しも見る）" },
  { value: "fx_other", label: "合成の選択肢ニ（別の面）" },
  { value: "fx_unknown", label: "合成の選択肢ホ（判断できない）" }
];
const INTENT_QUESTION = "この画像の見え方は、合成された狙いに合っていますか（受入検査用の設問）";

function basePolicy() {
  return {
    arms: [{ id: "A", role: "slot", label: "A" }, { id: "B", role: "slot", label: "B" }],
    maxImagesPerArm: 4, requiredImagesPerArm: 2,
    verdicts: ["accept", "hold", "reject"],
    scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
    failureCodes: ["composition", "anatomy", "other", "fx_lost"],
    failureCodeLabels: { fx_lost: "合成の失敗分類（読みやすい短文）" },
    preferences: ["A", "B", "tie"],
    seedSupport: ["supported", "unsupported"],
    adoptionDecision: "not-applicable", rankImpliesAdoption: false
  };
}
function buildCases(n, tag) {
  return Array.from({ length: n }, (_, i) => {
    const no = i + 1;
    const a = `合成本文 ${tag}${no} A面。受入検査のための合成であり、実験の語彙は含まない。`;
    const b = `合成本文 ${tag}${no} B面。受入検査のための合成であり、実験の語彙は含まない。`;
    const settings = { schema: "t9_gen_settings.v1", salt: tag + no };
    return {
      sourceNo: no, caseId: tag + "-" + String(no).padStart(2, "0"),
      baselineGenerationId: "gen-" + tag.toLowerCase() + "-p" + String(no).padStart(3, "0"),
      role: "合成軸", species: "", reason: "合成フィクスチャ",
      batchId: tag.toLowerCase() + "-batch", no, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      arms: {
        A: { generationId: tag.toLowerCase() + "-p" + no + "-A", role: "control", prompt: a,
             promptSha256: sha(a), treatmentApplied: false, diffSummary: "合成" },
        B: { generationId: tag.toLowerCase() + "-p" + no + "-B", role: "treatment", prompt: b,
             promptSha256: sha(b), treatmentApplied: true, diffSummary: "合成" }
      }
    };
  });
}
function buildIntentPackage() {
  const cases = buildCases(2, "OI");
  const policy = Object.assign(basePolicy(), {
    opticalIntentAlignmentRequired: true,
    opticalIntentAlignmentSchema: "opticalIntentAlignment.v1",
    opticalIntentAlignmentQuestion: INTENT_QUESTION,
    opticalIntentAlignmentStatuses: INTENT_STATUSES,
    imageNotesPlaceholder: "コメント（合成の受入検査用）"
  });
  return reseal({
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-23T00:00:00.000Z", generatedBy: "fixture-optical-intent",
    experiment: { experimentId: "fixture-optical-intent", hypothesis: "合成",
      automaticProductionUpdate: false, seedSupported: false },
    policy,
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2",
      experimentSchemaVersion: "persona-fixture-optical-intent-ab.v1" },
    cases
  });
}
// 宣言の無い従来型（後方互換の確認用）
function buildLegacyPackage() {
  const cases = buildCases(1, "LG");
  return reseal({
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-23T00:00:00.000Z", generatedBy: "fixture-legacy-intent",
    experiment: { experimentId: "fixture-legacy-intent", hypothesis: "合成",
      automaticProductionUpdate: false, seedSupported: false },
    policy: basePolicy(),
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2",
      experimentSchemaVersion: "persona-fixture-legacy-intent-ab.v1" },
    cases
  });
}
// 壊れた宣言。1回に1箇所だけ壊し、必ず封をし直す。
function buildRejectFixtures(base) {
  const out = [];
  const add = (label, expectField, mutate) => {
    const p = clone(base);
    mutate(p);
    out.push({ label, expectField, pkg: reseal(p), name: "reject-oi-" + out.length + ".json" });
  };
  add("選択肢が1つしかない", "policy.opticalIntentAlignmentStatuses",
    (p) => { p.policy.opticalIntentAlignmentStatuses = [INTENT_STATUSES[0]]; });
  add("選択肢が配列でない", "policy.opticalIntentAlignmentStatuses",
    (p) => { p.policy.opticalIntentAlignmentStatuses = "fx_ok,fx_hard"; });
  add("選択肢の値が重複", "policy.opticalIntentAlignmentStatuses[2].value", (p) => {
    p.policy.opticalIntentAlignmentStatuses = INTENT_STATUSES.slice(0, 3).map((s, i) =>
      (i === 2 ? { value: INTENT_STATUSES[0].value, label: s.label } : s));
  });
  add("選択肢にラベルが無い", "policy.opticalIntentAlignmentStatuses[1].label", (p) => {
    p.policy.opticalIntentAlignmentStatuses = INTENT_STATUSES.slice(0, 3).map((s, i) =>
      (i === 1 ? { value: s.value } : s));
  });
  add("選択肢の値が空", "policy.opticalIntentAlignmentStatuses[0].value", (p) => {
    p.policy.opticalIntentAlignmentStatuses = INTENT_STATUSES.slice(0, 3).map((s, i) =>
      (i === 0 ? { value: "", label: s.label } : s));
  });
  add("設問文が空文字", "policy.opticalIntentAlignmentQuestion",
    (p) => { p.policy.opticalIntentAlignmentQuestion = ""; });
  add("3段階の合焦入力と併用", "policy.opticalIntentAlignmentRequired", (p) => {
    p.policy.focusRubricRequired = true;
    p.policy.focusRubricSchema = "focusAssessment.v1";
    p.cases.forEach((c) => { c.focusRubric = { targetLabel: "合成の対象", separationRequired: false }; });
  });
  return out;
}

module.exports = { sha, reseal, buildIntentPackage, buildLegacyPackage, buildRejectFixtures,
  INTENT_STATUSES, INTENT_QUESTION };
