/** Separate experimental treatment, explicitly selected for any configured model. */
export const GUEST_ECONOMY_SHAPE_VERSION = 'guest-economy-shape-v1'
export const GUEST_ECONOMY_SHAPE_INSTRUCTION = `ECONOMY ANSWER SHAPE (trusted system rule):
Give the deciding fact and what it means first. Usually 35 to 45 words in one natural paragraph. Cover all asked parts and preserve limits; expand for lists, plans, explanation or safety. Offer a supported family option before asking for missing measured height. Preserve the selected response-depth budget for expanded and comparison answers.`

export function guestEconomyShapeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GUEST_CHAT_ECONOMY_SHAPE?.trim().toLowerCase() === 'on'
}

export function appendGuestEconomyShapeInstruction(dynamicPart: string): string {
  return `${dynamicPart}\n\n${GUEST_ECONOMY_SHAPE_INSTRUCTION}`
}
