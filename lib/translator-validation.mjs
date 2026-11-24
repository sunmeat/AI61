const languageCodes = new Set(['ukr_Cyrl', 'eng_Latn'])

export function validateTranslationRequest({ text, source, target }) {
  if (typeof text !== 'string' || !text.trim()) return 'Введіть короткий текст перед перекладом.'
  if (text.length > 1400) return 'Скоротіть текст до 1 400 символів.'
  if (!languageCodes.has(source) || !languageCodes.has(target)) return 'Непідтримуваний код мови. Доступні лише ukr_Cyrl та eng_Latn.'
  if (source === target) return 'Оберіть різні мови для перекладу.'
  return null
}
