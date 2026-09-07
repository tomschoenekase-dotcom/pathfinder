import type { SupportedChatLanguage } from '@pathfinder/api/schemas'

const copy: Record<SupportedChatLanguage, readonly [find: string, alreadyHere: string]> = {
  English: ['Find a reachable restroom', 'Your selected starting point is already a restroom.'],
  Español: [
    'Buscar un baño al que se pueda llegar',
    'El punto de partida seleccionado ya es un baño.',
  ],
  Français: [
    'Trouver des toilettes accessibles par un itinéraire',
    'Le point de départ sélectionné correspond déjà à des toilettes.',
  ],
  Deutsch: [
    'Eine erreichbare Toilette finden',
    'Der gewählte Startpunkt ist bereits eine Toilette.',
  ],
  Italiano: ['Trova un bagno raggiungibile', 'Il punto di partenza selezionato è già un bagno.'],
  Português: [
    'Encontrar um banheiro com rota disponível',
    'O ponto de partida selecionado já é um banheiro.',
  ],
  中文: ['查找有路线可达的洗手间', '所选起点已经是洗手间。'],
  日本語: ['経路が確認されたトイレを探す', '選択した出発地点はすでにトイレです。'],
  한국어: ['이동 경로가 있는 화장실 찾기', '선택한 출발 지점이 이미 화장실입니다.'],
  العربية: ['ابحث عن دورة مياه لها مسار متاح', 'نقطة البداية المحددة هي بالفعل دورة مياه.'],
}

export const getVisitorRestroomCopy = (language: SupportedChatLanguage) => copy[language]
