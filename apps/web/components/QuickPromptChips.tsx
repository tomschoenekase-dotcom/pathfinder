import React from 'react'
import { LANGUAGE_START_LABELS } from './LanguagePicker'

type PromptSet = {
  location: (venueName?: string, venueCategory?: string) => string[]
  nonLocation: (venueName?: string) => string[]
}

const LOCALIZED_PROMPTS: Record<string, PromptSet> = {
  English: {
    location: (venueName, venueCategory) => [
      "What's worth seeing near me right now?",
      'Where should I go next?',
      'Where are the restrooms?',
      "What's good to eat or drink here?",
      venueName ? `What makes ${venueName} special?` : "What's this venue all about?",
      venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
        ? 'What animals can I see today?'
        : "What's good to do with kids?",
    ],
    nonLocation: (venueName) => [
      'What should I know first?',
      'Explain this place to me.',
      'Walk me through what to do when I arrive.',
      'What is the most important thing to know here?',
      venueName ? `Tell me about ${venueName}.` : 'Tell me about this place.',
      'Can you explain something in simpler terms?',
    ],
  },
  Español: {
    location: (venueName, venueCategory) => [
      '¿Qué vale la pena ver cerca de mí ahora mismo?',
      '¿A dónde debería ir después?',
      '¿Dónde están los baños?',
      '¿Qué está bueno para comer o beber aquí?',
      venueName ? `¿Qué hace especial a ${venueName}?` : '¿De qué trata este lugar?',
      venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
        ? '¿Qué animales puedo ver hoy?'
        : '¿Qué se puede hacer con niños?',
    ],
    nonLocation: (venueName) => [
      '¿Qué debo saber primero?',
      'Explícame este lugar.',
      'Dime qué debo hacer cuando llegue.',
      '¿Qué es lo más importante que debo saber aquí?',
      venueName ? `Cuéntame sobre ${venueName}.` : 'Cuéntame sobre este lugar.',
      '¿Puedes explicar algo en términos más simples?',
    ],
  },
  Français: {
    location: (venueName, venueCategory) => [
      "Qu'est-ce qui vaut la peine d'être vu près de moi maintenant ?",
      'Où devrais-je aller ensuite ?',
      'Où sont les toilettes ?',
      "Qu'y a-t-il de bon à manger ou à boire ici ?",
      venueName ? `Qu'est-ce qui rend ${venueName} spécial ?` : 'De quoi parle cet endroit ?',
      venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
        ? "Quels animaux puis-je voir aujourd'hui ?"
        : "Qu'est-ce qu'il y a de bien à faire avec des enfants ?",
    ],
    nonLocation: (venueName) => [
      'Que dois-je savoir en premier ?',
      'Expliquez-moi cet endroit.',
      'Dites-moi ce que je dois faire à mon arrivée.',
      'Quelle est la chose la plus importante à savoir ici ?',
      venueName ? `Parlez-moi de ${venueName}.` : 'Parlez-moi de cet endroit.',
      'Pouvez-vous expliquer quelque chose en termes plus simples ?',
    ],
  },
  Deutsch: {
    location: (venueName, venueCategory) => [
      'Was lohnt sich gerade in meiner Nähe anzusehen?',
      'Wohin sollte ich als Nächstes gehen?',
      'Wo sind die Toiletten?',
      'Was gibt es hier Gutes zu essen oder zu trinken?',
      venueName ? `Was macht ${venueName} besonders?` : 'Worum geht es in diesem Ort?',
      venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
        ? 'Welche Tiere kann ich heute sehen?'
        : 'Was kann man mit Kindern unternehmen?',
    ],
    nonLocation: (venueName) => [
      'Was sollte ich zuerst wissen?',
      'Erklären Sie mir diesen Ort.',
      'Führen Sie mich durch, was ich bei meiner Ankunft tun soll.',
      'Was ist das Wichtigste, das ich hier wissen sollte?',
      venueName ? `Erzählen Sie mir von ${venueName}.` : 'Erzählen Sie mir von diesem Ort.',
      'Können Sie etwas einfacher erklären?',
    ],
  },
  Italiano: {
    location: (venueName, venueCategory) => [
      'Cosa vale la pena vedere vicino a me adesso?',
      'Dove dovrei andare dopo?',
      'Dove sono i bagni?',
      "Cosa c'è di buono da mangiare o bere qui?",
      venueName ? `Cosa rende speciale ${venueName}?` : 'Di cosa si tratta questo posto?',
      venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
        ? 'Quali animali posso vedere oggi?'
        : "Cosa c'è di bello da fare con i bambini?",
    ],
    nonLocation: (venueName) => [
      'Cosa devo sapere prima?',
      'Spiegami questo posto.',
      'Guidami su cosa fare quando arrivo.',
      'Qual è la cosa più importante da sapere qui?',
      venueName ? `Parlami di ${venueName}.` : 'Parlami di questo posto.',
      'Puoi spiegare qualcosa in termini più semplici?',
    ],
  },
  Português: {
    location: (venueName, venueCategory) => [
      'O que vale a pena ver perto de mim agora?',
      'Para onde devo ir em seguida?',
      'Onde ficam os banheiros?',
      'O que é bom para comer ou beber aqui?',
      venueName ? `O que torna ${venueName} especial?` : 'Do que se trata este lugar?',
      venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
        ? 'Que animais posso ver hoje?'
        : 'O que é bom fazer com crianças?',
    ],
    nonLocation: (venueName) => [
      'O que devo saber primeiro?',
      'Explique-me este lugar.',
      'Me guie sobre o que fazer quando chegar.',
      'Qual é a coisa mais importante a saber aqui?',
      venueName ? `Fale-me sobre ${venueName}.` : 'Fale-me sobre este lugar.',
      'Você pode explicar algo em termos mais simples?',
    ],
  },
  中文: {
    location: (venueName, venueCategory) => [
      '我附近现在有什么值得一看的？',
      '我下一步应该去哪里？',
      '洗手间在哪里？',
      '这里有什么好吃好喝的？',
      venueName ? `${venueName}有什么特别之处？` : '这个地方是做什么的？',
      venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
        ? '今天可以看到什么动物？'
        : '带孩子来有什么好玩的？',
    ],
    nonLocation: (venueName) => [
      '我首先需要知道什么？',
      '请向我介绍这个地方。',
      '请告诉我到达后应该做什么。',
      '这里最重要的事情是什么？',
      venueName ? `请告诉我关于${venueName}的信息。` : '请告诉我关于这个地方的信息。',
      '你能用更简单的语言解释一下吗？',
    ],
  },
  日本語: {
    location: (venueName, venueCategory) => [
      '今、近くで見る価値があるものは何ですか？',
      '次にどこへ行けばいいですか？',
      'トイレはどこですか？',
      'ここで食べたり飲んだりするのに良いものは何ですか？',
      venueName ? `${venueName}の魅力は何ですか？` : 'この場所はどんなところですか？',
      venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
        ? '今日はどんな動物を見ることができますか？'
        : '子供と一緒に楽しめることは何ですか？',
    ],
    nonLocation: (venueName) => [
      '最初に知っておくべきことは何ですか？',
      'この場所について説明してください。',
      '到着したら何をすべきか教えてください。',
      'ここで最も重要なことは何ですか？',
      venueName ? `${venueName}について教えてください。` : 'この場所について教えてください。',
      'もっと簡単な言葉で説明してもらえますか？',
    ],
  },
  한국어: {
    location: (venueName, venueCategory) => [
      '지금 근처에서 볼 만한 것이 무엇인가요?',
      '다음에 어디로 가야 할까요?',
      '화장실은 어디에 있나요?',
      '여기서 먹거나 마시기 좋은 것은 무엇인가요?',
      venueName ? `${venueName}의 특별한 점은 무엇인가요?` : '이 장소는 어떤 곳인가요?',
      venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
        ? '오늘 어떤 동물들을 볼 수 있나요?'
        : '아이들과 함께 하기 좋은 것은 무엇인가요?',
    ],
    nonLocation: (venueName) => [
      '먼저 무엇을 알아야 하나요?',
      '이 장소를 설명해 주세요.',
      '도착하면 무엇을 해야 하는지 안내해 주세요.',
      '여기서 가장 중요한 것은 무엇인가요?',
      venueName ? `${venueName}에 대해 알려주세요.` : '이 장소에 대해 알려주세요.',
      '더 쉬운 말로 설명해 주실 수 있나요?',
    ],
  },
  العربية: {
    location: (venueName, venueCategory) => [
      'ما الذي يستحق المشاهدة بالقرب مني الآن؟',
      'أين يجب أن أذهب بعد ذلك؟',
      'أين دورات المياه؟',
      'ما الذي يستحق تناوله أو شربه هنا؟',
      venueName ? `ما الذي يجعل ${venueName} مميزًا؟` : 'ما الذي يدور في هذا المكان؟',
      venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
        ? 'ما الحيوانات التي يمكنني رؤيتها اليوم؟'
        : 'ما الذي يمكن فعله مع الأطفال؟',
    ],
    nonLocation: (venueName) => [
      'ما الذي يجب أن أعرفه أولاً؟',
      'اشرح لي هذا المكان.',
      'أرشدني إلى ما يجب فعله عند وصولي.',
      'ما أهم شيء يجب معرفته هنا؟',
      venueName ? `أخبرني عن ${venueName}.` : 'أخبرني عن هذا المكان.',
      'هل يمكنك الشرح بكلمات أبسط؟',
    ],
  },
}

type QuickPromptChipsProps = {
  onSend: (message: string) => void
  language?: string | undefined
  venueName?: string | undefined
  venueCategory?: string | undefined
  guideMode?: string | undefined
}

export function buildPrompts(
  venueName?: string,
  venueCategory?: string,
  guideMode?: string,
  language = 'English',
): string[] {
  const set = LOCALIZED_PROMPTS[language] ?? LOCALIZED_PROMPTS['English']!
  return guideMode === 'non_location'
    ? set.nonLocation(venueName)
    : set.location(venueName, venueCategory)
}

export function QuickPromptChips({
  onSend,
  language = 'English',
  venueName,
  venueCategory,
  guideMode,
}: QuickPromptChipsProps) {
  const prompts = buildPrompts(venueName, venueCategory, guideMode, language)
  const startLabel = LANGUAGE_START_LABELS[language] ?? LANGUAGE_START_LABELS['English']!

  return (
    <section className="mb-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-[var(--chat-text-muted)]">
        {startLabel}
      </p>
      <div className="flex flex-wrap gap-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            className="inline-flex min-h-10 items-center justify-center rounded-full border border-[var(--chat-border)] bg-[var(--chat-card)] px-4 text-center text-sm font-medium text-[var(--chat-accent)] shadow-sm transition hover:border-[var(--chat-accent)] hover:bg-[var(--chat-accent)]/5"
            type="button"
            onClick={() => {
              onSend(prompt)
            }}
          >
            {prompt}
          </button>
        ))}
      </div>
    </section>
  )
}
