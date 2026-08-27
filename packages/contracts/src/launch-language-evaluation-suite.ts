import type { ReviewableVenuePackageEvaluationPreview } from './client-package-preview'
import { EVAL_SCHEMA_VERSION, EvalCaseSchema, type EvalCase, type EvalLanguage } from './evaluation'

export const LAUNCH_LANGUAGE_EVALUATION_SUITE_VERSION =
  'torchiko-launch-language-evaluation-suite-v1' as const

type LanguageContract = {
  code: EvalLanguage
  groundedPrompt: string
  groundedMarkers: string[]
  fallbackPrompt: string
  fallbackMarkers: string[]
}

export const LAUNCH_LANGUAGE_EVALUATION_CONTRACTS: readonly LanguageContract[] = [
  {
    code: 'en',
    groundedPrompt: 'What is the name of this venue? Answer in a full English sentence.',
    groundedMarkers: ['This venue is called', 'The venue is called', 'Its name is'],
    fallbackPrompt: 'May I bring an oversized bag inside?',
    fallbackMarkers: ["I don't have that policy information", "I don't have that information"],
  },
  {
    code: 'es',
    groundedPrompt: '¿Cómo se llama este lugar? Responde con una oración completa en español.',
    groundedMarkers: ['Este lugar se llama', 'El lugar se llama', 'Se llama'],
    fallbackPrompt: '¿Puedo entrar con una bolsa de gran tamaño?',
    fallbackMarkers: ['No tengo esa información', 'No dispongo de esa información'],
  },
  {
    code: 'fr',
    groundedPrompt: 'Comment s’appelle ce lieu ? Répondez par une phrase complète en français.',
    groundedMarkers: ['Ce lieu s’appelle', "Le lieu s'appelle", "Il s'appelle"],
    fallbackPrompt: 'Puis-je entrer avec un sac volumineux ?',
    fallbackMarkers: ["Je n'ai pas cette information", 'Je ne dispose pas de cette information'],
  },
  {
    code: 'de',
    groundedPrompt: 'Wie heißt dieser Ort? Antworte mit einem vollständigen deutschen Satz.',
    groundedMarkers: ['Dieser Ort heißt', 'Der Ort heißt', 'Er heißt'],
    fallbackPrompt: 'Darf ich eine übergroße Tasche mitbringen?',
    fallbackMarkers: [
      'Diese Information zur Regelung habe ich nicht',
      'Diese Information habe ich nicht',
      'Dazu liegen mir keine Informationen vor',
    ],
  },
  {
    code: 'it',
    groundedPrompt: 'Come si chiama questo luogo? Rispondi con una frase completa in italiano.',
    groundedMarkers: ['Questo luogo si chiama', 'Il luogo si chiama', 'Si chiama'],
    fallbackPrompt: 'Posso entrare con una borsa molto grande?',
    fallbackMarkers: ['Non ho questa informazione', 'Non dispongo di questa informazione'],
  },
  {
    code: 'pt',
    groundedPrompt: 'Qual é o nome deste local? Responda com uma frase completa em português.',
    groundedMarkers: ['Este local se chama', 'O local se chama', 'Chama-se'],
    fallbackPrompt: 'Posso entrar com uma bolsa muito grande?',
    fallbackMarkers: ['Não tenho essa informação', 'Não disponho dessa informação'],
  },
  {
    code: 'zh',
    groundedPrompt: '这个场馆叫什么名字？请用完整的中文句子回答。',
    groundedMarkers: ['这个场馆叫', '场馆的名字是', '它叫'],
    fallbackPrompt: '我可以带超大包入内吗？',
    fallbackMarkers: ['我没有这项规定的信息', '我没有这方面的信息'],
  },
  {
    code: 'ja',
    groundedPrompt: 'この施設の名前は何ですか？完全な日本語の文で答えてください。',
    groundedMarkers: ['この施設の名前は', '施設名は', 'この施設は'],
    fallbackPrompt: '大型バッグを持ち込めますか？',
    fallbackMarkers: ['その規則についての情報はありません', 'その情報はありません'],
  },
  {
    code: 'ko',
    groundedPrompt: '이 시설의 이름은 무엇인가요? 완전한 한국어 문장으로 답해 주세요.',
    groundedMarkers: ['이 시설의 이름은', '시설 이름은', '이 시설은'],
    fallbackPrompt: '대형 가방을 가지고 들어갈 수 있나요?',
    fallbackMarkers: ['해당 규정에 대한 정보가 없습니다', '그 정보가 없습니다'],
  },
  {
    code: 'ar',
    groundedPrompt: 'ما اسم هذا المكان؟ أجب بجملة عربية كاملة.',
    groundedMarkers: ['اسم هذا المكان هو', 'يُسمى هذا المكان', 'هذا المكان هو'],
    fallbackPrompt: 'هل يمكنني إدخال حقيبة كبيرة الحجم؟',
    fallbackMarkers: ['ليست لدي معلومات عن هذه السياسة', 'ليست لدي هذه المعلومات'],
  },
] as const

export type LaunchLanguageEvaluationCase = {
  dimension: 'launch-language-grounded' | 'launch-language-fallback'
  language: EvalLanguage
  evalCase: EvalCase
}

type LaunchLanguageEvaluationPreview = {
  venue: Pick<ReviewableVenuePackageEvaluationPreview['venue'], 'name'>
  experience: {
    places: Array<
      Pick<ReviewableVenuePackageEvaluationPreview['experience']['places'][number], 'name'>
    >
  }
}

export function buildLaunchLanguageEvaluationSuite(
  preview: LaunchLanguageEvaluationPreview,
): LaunchLanguageEvaluationCase[] {
  const allowedPlaceNames = preview.experience.places.map((place) => place.name).slice(0, 99)
  const baseVenue = {
    fixtureId: 'reviewable-package',
    guideMode: 'location_aware' as const,
    placeNameUniverse: allowedPlaceNames,
    allowedPlaceNames,
  }

  return LAUNCH_LANGUAGE_EVALUATION_CONTRACTS.flatMap((language) => {
    const shared = {
      schemaVersion: EVAL_SCHEMA_VERSION,
      venue: baseVenue,
    }
    return [
      {
        dimension: 'launch-language-grounded' as const,
        language: language.code,
        evalCase: EvalCaseSchema.parse({
          ...shared,
          caseId: `onboarding-language-${language.code}-grounded`,
          category: 'known-answer',
          dimensions: {
            intent: 'general-information',
            risk: 'low',
            language: language.code,
            locationContext: 'whole-venue',
          },
          turns: [{ role: 'user', content: language.groundedPrompt }],
          rules: {
            requiredPhrases: [],
            requiredFacts: [
              { ruleId: 'approved-venue-name', acceptablePhrases: [preview.venue.name] },
              { ruleId: 'selected-language', acceptablePhrases: language.groundedMarkers },
            ],
            forbiddenPhrases: [],
            maxWords: 45,
            unknownAnswer: { required: false, ruleId: 'unknown-boundary', acceptablePhrases: [] },
          },
        }),
      },
      {
        dimension: 'launch-language-fallback' as const,
        language: language.code,
        evalCase: EvalCaseSchema.parse({
          ...shared,
          caseId: `onboarding-language-${language.code}-fallback`,
          category: 'unknown-answer',
          dimensions: {
            intent: 'policy',
            risk: 'moderate',
            language: language.code,
            locationContext: 'arrival',
          },
          turns: [{ role: 'user', content: language.fallbackPrompt }],
          rules: {
            requiredPhrases: [],
            requiredFacts: [],
            forbiddenPhrases: [],
            maxWords: 45,
            unknownAnswer: {
              required: true,
              ruleId: 'unknown-boundary',
              acceptablePhrases: language.fallbackMarkers,
            },
          },
        }),
      },
    ]
  })
}
