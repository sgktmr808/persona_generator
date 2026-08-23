// 追加レビュー項目(policy.reviewChoiceItems)と交互キューの受入検査で共有する**合成フィクスチャ**。
//  実験の実データ・本文・ID・語彙・評価値・判定閾値は1つも含まない。
"use strict";
const crypto = require("node:crypto");

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

const PER_ARM = 6;

// 選択肢も設問も**合成の語彙**。実験の分類名をこの検査へ持ち込まない。
const REQUIRED_ITEM = {
  key: "fixtureJointState",
  label: "合成の接合状態",
  question: "合成の接合部はどう見えますか（受入検査用の設問）",
  required: true,
  note: "見えていない場合と、見えているが判断できない場合を分けて選んでください。",
  options: [
    { value: "fx_intact", label: "合成イ（つながっている）",
      description: "合成の説明イ。左右の合成部位が自然につながっている、という意味をその場に出す。" },
    { value: "fx_broken", label: "合成ロ（破綻している）",
      description: "合成の説明ロ。位置・数・左右・接合のいずれかが破綻している、という意味。" },
    { value: "fx_absent", label: "合成ハ（画面に見えていない）",
      description: "合成の説明ハ。判定に必要な部位が画面に写っていない、という意味。長めの説明で折返しも見る。" },
    { value: "fx_unknown", label: "合成ニ（見えているが判断できない）",
      description: "合成の説明ニ。写ってはいるが、この画像からは判定できない、という意味。" }
  ]
};
const OPTIONAL_ITEM = {
  key: "fixtureOptionalNote",
  label: "合成の任意項目",
  question: "合成の任意設問（未入力でも完了を止めない）",
  required: false,
  options: [
    { value: "fx_yes", label: "合成はい", description: "合成の説明。任意項目でも意味はその場に出す。" },
    { value: "fx_no", label: "合成いいえ", description: "合成の説明。こちらも意味をその場に出す。" }
  ]
};

function basePolicy() {
  return {
    arms: [{ id: "A", role: "slot", label: "A" }, { id: "B", role: "slot", label: "B" }],
    maxImagesPerArm: PER_ARM, requiredImagesPerArm: PER_ARM,
    verdicts: ["accept", "hold", "reject"],
    scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
    failureCodes: ["composition", "anatomy", "other"],
    preferences: ["A", "B", "tie"],
    seedSupport: ["supported", "unsupported"],
    adoptionDecision: "not-applicable", rankImpliesAdoption: false,
    imageNotesPlaceholder: "コメント（合成の受入検査用）"
  };
}
function longPrompt(tag) {
  return `合成本文 ${tag} 一行目\n合成の指示 ${tag}。`
    + "これは受入検査のための合成本文であり、実験の語彙は含まない。"
    + "長い一文の折返しと読み取り専用欄での表示を確かめるために、句読点を挟みながら十分な長さにしてある。";
}

const QUEUE_KEYS = ["sequence", "caseId", "sourceNo", "slot", "rank", "armGenerationId", "promptSha256"];
function normalizedQueueText(items) {
  return JSON.stringify(items.map((i) => {
    const out = {};
    QUEUE_KEYS.forEach((k) => { out[k] = i[k]; });
    return out;
  }));
}

// 1ケース・各面6枚・交互キュー(12手順)の案内付きパッケージ。
function buildChoicePackage() {
  const slotRoles = { A: "treatment", B: "control" };
  const generationOrder = ["control", "treatment"];
  const promptFor = (slot) => longPrompt("RC-1" + slot);
  const a = promptFor("A"), b = promptFor("B");
  const settings = { schema: "t9_gen_settings.v1", salt: "rc-1" };
  const cases = [{
    sourceNo: 1, caseId: "RC-01", baselineGenerationId: "gen-rc-p001",
    role: "合成軸", species: "", reason: "合成フィクスチャ",
    batchId: "rc-batch", no: 1, settings, settingsRaw: JSON.stringify(settings),
    baselinePromptSha256: sha(b),
    slotRoles, generationOrder, evaluationOrder: 1, imagesPerArm: PER_ARM,
    arms: {
      A: { generationId: "rc-p1-A", role: slotRoles.A, prompt: a, promptSha256: sha(a),
           treatmentApplied: true, diffSummary: "合成" },
      B: { generationId: "rc-p1-B", role: slotRoles.B, prompt: b, promptSha256: sha(b),
           treatmentApplied: false, diffSummary: "合成" }
    }
  }];
  const slotForRole = {};
  slotForRole[slotRoles.A] = "A";
  slotForRole[slotRoles.B] = "B";
  const slots = generationOrder.map((r) => slotForRole[r]);
  const items = [];
  for (let rank = 1; rank <= PER_ARM; rank += 1) {
    slots.forEach((slot) => {
      items.push({
        sequence: items.length + 1, caseId: "RC-01", sourceNo: 1, slot, rank,
        armGenerationId: "rc-p1-" + slot, promptSha256: sha(promptFor(slot))
      });
    });
  }
  return reseal({
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-23T00:00:00.000Z", generatedBy: "fixture-review-choice",
    experiment: {
      experimentId: "fixture-review-choice",
      title: "合成 追加レビュー項目 + 交互キュー",
      hypothesis: "合成",
      generationConditions: { provider: "openai", model: "合成モデルUI", seedSupport: "unsupported", imageSeed: null },
      generationExecution: {
        schemaVersion: "fixture.generation-execution.v1",
        derivedFrom: "cases[].generationOrder + cases[].slotRoles",
        slotSequencing: "alternating-slots",
        itemCount: items.length,
        normalizedQueueSha256: sha(normalizedQueueText(items)),
        exposesRoleSemantics: false,
        items
      },
      automaticProductionUpdate: false, seedSupported: false
    },
    policy: Object.assign(basePolicy(), { reviewChoiceItems: [REQUIRED_ITEM, OPTIONAL_ITEM] }),
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2",
      experimentSchemaVersion: "persona-fixture-review-choice-ab.v1" },
    cases
  });
}

// 宣言の無い従来型（後方互換の確認用・案内キューも持たない）
function buildLegacyPackage() {
  const a = longPrompt("LC-1A"), b = longPrompt("LC-1B");
  const settings = { schema: "t9_gen_settings.v1", salt: "lc-1" };
  return reseal({
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-23T00:00:00.000Z", generatedBy: "fixture-legacy-choice",
    experiment: { experimentId: "fixture-legacy-choice", hypothesis: "合成",
      automaticProductionUpdate: false, seedSupported: false },
    policy: Object.assign(basePolicy(), { maxImagesPerArm: 2, requiredImagesPerArm: 2 }),
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2",
      experimentSchemaVersion: "persona-fixture-legacy-choice-ab.v1" },
    cases: [{
      sourceNo: 1, caseId: "LC-01", baselineGenerationId: "gen-lc-p001",
      role: "合成軸", species: "", reason: "合成フィクスチャ",
      batchId: "lc-batch", no: 1, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      arms: {
        A: { generationId: "lc-p1-A", role: "control", prompt: a, promptSha256: sha(a),
             treatmentApplied: false, diffSummary: "合成" },
        B: { generationId: "lc-p1-B", role: "treatment", prompt: b, promptSha256: sha(b),
             treatmentApplied: true, diffSummary: "合成" }
      }
    }]
  });
}

// 従来どおり片面をまとめて撮る案内付きパッケージ（既存の並びが変わらないことの確認用）
function buildGroupedPackage() {
  const pkg = clone(buildChoicePackage());
  pkg.experiment.experimentId = "fixture-grouped-choice";
  delete pkg.experiment.generationExecution.slotSequencing;   // 宣言なし = 従来どおり
  const slots = ["B", "A"];   // generationOrder = control, treatment / slotRoles B=control
  const items = [];
  slots.forEach((slot) => {
    for (let rank = 1; rank <= PER_ARM; rank += 1) {
      items.push({
        sequence: items.length + 1, caseId: "RC-01", sourceNo: 1, slot, rank,
        armGenerationId: "rc-p1-" + slot,
        promptSha256: pkg.cases[0].arms[slot].promptSha256
      });
    }
  });
  pkg.experiment.generationExecution.items = items;
  pkg.experiment.generationExecution.normalizedQueueSha256 = sha(normalizedQueueText(items));
  return reseal(pkg);
}

// 壊れた宣言。1回に1箇所だけ壊し、必ず封をし直す。
function buildRejectFixtures(base) {
  const out = [];
  const add = (label, expectField, mutate) => {
    const p = clone(base);
    mutate(p);
    out.push({ label, expectField, pkg: reseal(p), name: "reject-rc-" + out.length + ".json" });
  };
  add("項目が配列でない", "policy.reviewChoiceItems",
    (p) => { p.policy.reviewChoiceItems = "fixtureJointState"; });
  add("項目が空配列", "policy.reviewChoiceItems",
    (p) => { p.policy.reviewChoiceItems = []; });
  add("項目名が識別子として使えない", "policy.reviewChoiceItems[0].key",
    (p) => { p.policy.reviewChoiceItems[0].key = "2 bad key"; });
  add("項目名が既存の評価項目と衝突", "policy.reviewChoiceItems[0].key",
    (p) => { p.policy.reviewChoiceItems[0].key = "failures"; });
  add("項目名が採点項目と衝突", "policy.reviewChoiceItems[0].key",
    (p) => { p.policy.reviewChoiceItems[0].key = "intentMatch"; });
  add("項目名が重複", "policy.reviewChoiceItems[1].key",
    (p) => { p.policy.reviewChoiceItems[1].key = p.policy.reviewChoiceItems[0].key; });
  add("設問文が空", "policy.reviewChoiceItems[0].question",
    (p) => { p.policy.reviewChoiceItems[0].question = ""; });
  add("required が真偽値でない", "policy.reviewChoiceItems[0].required",
    (p) => { p.policy.reviewChoiceItems[0].required = "yes"; });
  add("選択肢が1つしかない", "policy.reviewChoiceItems[0].options",
    (p) => { p.policy.reviewChoiceItems[0].options = [REQUIRED_ITEM.options[0]]; });
  add("選択肢の値が重複", "policy.reviewChoiceItems[0].options[1].value", (p) => {
    p.policy.reviewChoiceItems[0].options[1] =
      Object.assign({}, REQUIRED_ITEM.options[1], { value: REQUIRED_ITEM.options[0].value });
  });
  add("選択肢の値が空", "policy.reviewChoiceItems[0].options[0].value", (p) => {
    p.policy.reviewChoiceItems[0].options[0] =
      Object.assign({}, REQUIRED_ITEM.options[0], { value: "" });
  });
  add("選択肢に短文が無い", "policy.reviewChoiceItems[0].options[2].label", (p) => {
    const o = Object.assign({}, REQUIRED_ITEM.options[2]);
    delete o.label;
    p.policy.reviewChoiceItems[0].options[2] = o;
  });
  add("選択肢の説明が空文字", "policy.reviewChoiceItems[0].options[1].description", (p) => {
    p.policy.reviewChoiceItems[0].options[1] =
      Object.assign({}, REQUIRED_ITEM.options[1], { description: "" });
  });
  add("項目名ラベルが空文字", "policy.reviewChoiceItems[0].label",
    (p) => { p.policy.reviewChoiceItems[0].label = ""; });
  // 交互キューの契約破り
  add("面の並べ方が対応外", "experiment.generationExecution.slotSequencing",
    (p) => { p.experiment.generationExecution.slotSequencing = "random-slots"; });
  add("交互と宣言しながら並びがまとめ撮り", "experiment.generationExecution.items[1]", (p) => {
    const g = buildGroupedPackage();
    p.experiment.generationExecution.items = clone(g.experiment.generationExecution.items);
    p.experiment.generationExecution.normalizedQueueSha256 =
      sha(normalizedQueueText(p.experiment.generationExecution.items));
  });
  return out;
}

module.exports = {
  sha, reseal, buildChoicePackage, buildLegacyPackage, buildGroupedPackage, buildRejectFixtures,
  REQUIRED_ITEM, OPTIONAL_ITEM, PER_ARM
};
