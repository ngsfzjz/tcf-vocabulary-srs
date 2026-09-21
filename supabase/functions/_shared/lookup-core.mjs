export function normalizeTerm(value) {
  if (typeof value !== "string") throw new Error("请输入法语词或词组");
  const term = value.normalize("NFC").trim().replace(/\s+/g, " ");
  if (!term || term.length > 100 || /[\r\n<>]/.test(term)) throw new Error("请输入 1–100 字的法语词或词组");
  return term;
}

export function validateLookupResult(value) {
  if (!value || typeof value !== "object") throw new Error("查询结果格式错误");
  const limits = { translation: 180, partOfSpeech: 50, collocation: 160 };
  const result = {};
  for (const [key, limit] of Object.entries(limits)) {
    const text = value[key];
    if (typeof text !== "string" || !text.trim() || text.length > limit) throw new Error("查询结果不完整");
    result[key] = text.trim();
  }
  return result;
}

export function readOpenAiResult(payload) {
  const text = payload?.output_text || payload?.output?.flatMap((item) => item.content || [])?.find((item) => item.type === "output_text")?.text;
  if (typeof text !== "string") throw new Error("语言模型未返回释义");
  return validateLookupResult(JSON.parse(text));
}
