import { request } from './api'

/*
 * The "how to use bindet" help bot (components/HelpBot.tsx). Separate from Otto.
 *
 * Answers come from this local FAQ first: matched in the browser, instantly, with no
 * network or AI. Every entry is written from what the app actually does (the guides in
 * Settings → Help & feedback and the pages themselves). Only a question with no
 * confident match is sent to POST /api/help-bot, which has strict per-student limits.
 *
 * Answers may contain internal page links written as a hash in brackets, "(#tools)";
 * the panel turns the ones in HELP_LINKS into links. Keep backend/help_bot.py's
 * KNOWLEDGE in step with this list when a feature changes.
 */

export type HelpEntry = { id: string; question: string; answer: string; terms: string[] }

export const HELP_LINKS: Record<string, string> = {
  '#settings?help': 'Help & feedback',
  '#home': 'Home',
  '#tools': 'Study',
  '#tutor': 'Otto',
  '#goals': 'Tasks',
  '#stats': 'Project stats',
  '#progress': 'Progress',
  '#games': 'Practice lab',
  '#chat': 'Messages',
  '#profile': 'Friends & groups',
  '#settings': 'Settings',
}

export const HELP_EMAIL = 'officialbindet@gmail.com'
export const HELP_QUESTION_MAX = 200
export const HELP_DAILY_LIMIT = 5

/*
 * terms: words (or short phrases) that point at this entry, matched after the
 * question is normalized (see normalizeWords). A phrase counts more than a word.
 */
export const HELP_FAQ: HelpEntry[] = [
  {
    id: 'photo-notes',
    question: 'How do I add notes from a photo?',
    answer: 'Open Study (#tools), pick a course and a unit, and stay on the Notes view. Choose Take a photo of your notes: each photo becomes its own note, and Add another page adds the next one. bindet reads the text, then makes flashcards for you.',
    terms: ['photo', 'camera', 'handwritten', 'take a photo', 'scan', 'another page', 'upload photo', 'photo of my notes'],
  },
  {
    id: 'upload-notes',
    question: 'How do I upload or paste notes?',
    answer: 'In Study (#tools), pick a course and a unit, then use Upload a file (PDF, DOCX, TXT, Markdown, CSV or JSON, up to 4 MB) on the Notes view. To paste text, paste it and choose Add typed notes; it isn’t saved until you do. You can remove a note from the unit’s note list at any time.',
    terms: ['upload', 'pdf', 'docx', 'file', 'paste', 'typed notes', 'add notes', 'import', 'delete note', 'where notes'],
  },
  {
    id: 'courses',
    question: 'How do I add a course or a unit?',
    answer: 'Open Study (#tools) and choose Add course, then + Add unit for each topic or chapter. Manage courses lets you rename, recolor or reorder them.',
    terms: ['course', 'unit', 'add course', 'add unit', 'new course', 'chapter', 'subject', 'class', 'rename', 'manage courses'],
  },
  {
    id: 'flashcards',
    question: 'How do flashcards get made?',
    answer: 'When you add a note, bindet writes flashcards from that note only and saves them, so reopening them doesn’t make new ones. To change them, type instructions such as “focus on vocabulary” and choose Make new cards with these instructions. Very short notes may be too short for flashcards.',
    terms: ['flashcard', 'made', 'deck', 'make flashcards', 'new cards', 'remake', 'too short', 'generate flashcards'],
  },
  {
    id: 'review',
    question: 'What’s Review mode?',
    answer: 'In a unit’s Flashcards view (#tools), switch from Browse to Review. Show the answer, then rate it Again, Hard, Good or Easy (keys 1–4): cards you know come back later and cards you miss come back sooner. Home (#home) shows how many are due.',
    terms: ['review', 'review mode', 'due', 'again', 'hard', 'good', 'easy', 'spaced', 'repetition', 'browse'],
  },
  {
    id: 'focus',
    question: 'What does the Focus button do?',
    answer: 'Focus shows the current flashcard or question large, with fewer distractions. Use A− and A+ to change the text size, and Esc to leave.',
    terms: ['focus', 'focus mode', 'bigger text', 'text size', 'distraction', 'fullscreen'],
  },
  {
    id: 'quiz',
    question: 'How does the quiz work?',
    answer: 'Switch a unit to Quiz (#tools), pick Level 1, 2 or 3, then New question. Questions come from that unit’s notes, and bindet checks your answer, explains it and gives a hint. A right first try earns 10 XP, and 5 XP after a retry.',
    terms: ['quiz', 'question', 'level', 'new question', 'skip', 'hint', 'difficulty', 'harder', 'easier'],
  },
  {
    id: 'practice-test',
    question: 'How do I take a practice test?',
    answer: 'On a unit’s Quiz panel in Study (#tools), choose Take a practice test, or Test the whole course. Pick 5, 10 or 15 questions, timed or untimed. After you submit you see your score, which topics need work, and every answer explained.',
    terms: ['practice test', 'test', 'exam', 'timed', 'untimed', 'whole course', 'score', 'mock'],
  },
  {
    id: 'otto',
    question: 'What can Otto help with?',
    answer: 'Otto (#tutor) is your AI tutor: pick a course and unit so answers use your notes first, and attach up to 3 images. It explains your notes, guides you through homework, helps you prepare for exams and quizzes you. It has hourly and daily limits and can make mistakes.',
    terms: ['otto', 'tutor', 'ai', 'explain', 'homework help', 'ask otto', 'chatbot'],
  },
  {
    id: 'join-group',
    question: 'How do I join a study group?',
    answer: 'Ask a member for the group’s invite code, then open Friends & groups (#profile) and enter it under Join with a code. You can be in up to 5 groups, and a group holds up to 20 people.',
    terms: ['join', 'join group', 'invite code', 'invite', 'study group', 'group code', 'join with a code'],
  },
  {
    id: 'start-group',
    question: 'How do I start a study group?',
    answer: 'In Friends & groups (#profile), use Start a group and give it a name. Then share its invite code (shown on the group, tap to copy) so others can join.',
    terms: ['start group', 'create group', 'new group', 'make group', 'start a group', 'share code'],
  },
  {
    id: 'leave-group',
    question: 'How do I leave, transfer or delete a group?',
    answer: 'In Friends & groups (#profile), members can choose Leave group at any time. The owner can Transfer ownership to another member or Delete group after typing its name; its tasks become personal tasks of the people who created them.',
    terms: ['leave', 'leave group', 'transfer', 'ownership', 'owner', 'delete group', 'kick', 'remove member'],
  },
  {
    id: 'messages',
    question: 'How do I message my study group?',
    answer: 'Open Messages (#chat) and pick one of your study groups. Group chats are private to the group’s members, and you can attach images (JPG, PNG, WebP or GIF).',
    terms: ['message', 'messages', 'chat', 'group chat', 'send', 'talk', 'dm'],
  },
  {
    id: 'friends',
    question: 'How do I add a friend?',
    answer: 'Your friend code is in Settings (#settings) under Account. In Friends & groups (#profile), enter a friend’s code or search by name to send a request; they accept it from their notifications.',
    terms: ['friend', 'add friend', 'friend code', 'friend request', 'search people', 'find people', 'follow'],
  },
  {
    id: 'tasks',
    question: 'How do I add a task?',
    answer: 'Open Tasks (#goals) and use New task. Tasks can be personal or for a group, and you can see them as a list, a board or a calendar, with checklists, links and comments.',
    terms: ['task', 'todo', 'assignment', 'deadline', 'due date', 'board', 'calendar', 'new task', 'make task', 'add task'],
  },
  {
    id: 'practice-lab',
    question: 'What is the Practice lab?',
    answer: 'Practice lab (#games) runs timed rounds of 1, 2 or 5 minutes on the flashcards you’ve already saved, with personal bests for each unit. You can also challenge a friend or group member to play the same cards; they have 7 days.',
    terms: ['practice lab', 'lab', 'round', 'game', 'games', 'challenge', 'personal best', 'speed'],
  },
  {
    id: 'xp',
    question: 'How do XP and streaks work?',
    answer: 'You earn XP for right quiz answers (10 on the first try, 5 after a retry) and Practice lab rounds (up to 15 a round). Set a daily XP goal in Settings (#settings), and see your XP and streaks in Progress (#progress).',
    terms: ['xp', 'points', 'streak', 'daily goal', 'goal', 'level up', 'league', 'leaderboard', 'how many xp', 'earn xp'],
  },
  {
    id: 'progress',
    question: 'Where can I see my progress?',
    answer: 'Progress (#progress) is your mastery report: how well you know each course and unit from your quiz sessions, plus your account-wide XP and streak.',
    terms: ['progress', 'mastery', 'report', 'stats', 'statistics', 'how am i doing', 'weak topics'],
  },
  {
    id: 'dark-mode',
    question: 'How do I turn on dark mode?',
    answer: 'Open Settings (#settings) and under Appearance choose Light, Dark or System for the theme. It is saved on this device only.',
    terms: ['dark', 'dark mode', 'light mode', 'theme', 'appearance', 'night'],
  },
  {
    id: 'offline',
    question: 'Can I use bindet as an app or offline?',
    answer: 'When your browser supports it, Settings (#settings) shows an App section to install bindet on this device. Flashcards you have opened stay available offline.',
    terms: ['offline', 'install', 'mobile', 'phone', 'iphone', 'android', 'download', 'home screen', 'no internet'],
  },
  {
    id: 'profile',
    question: 'How do I change my name or username?',
    answer: 'Open Settings (#settings) and edit your display name and username under Profile. That is how friends and study groups see you.',
    terms: ['name', 'username', 'display name', 'profile', 'change name', 'avatar'],
  },
  {
    id: 'password',
    question: 'How do I change my password?',
    answer: 'Sign out in Settings (#settings), then choose Forgot password? on the log-in screen and follow the link in the email.',
    terms: ['password', 'forgot password', 'reset password', 'change password', 'log in', 'login', 'sign in'],
  },
  {
    id: 'delete-account',
    question: 'How do I delete my account?',
    answer: 'Open Settings (#settings), choose Delete account and type DELETE MY ACCOUNT. You may be asked to sign in again first. Everything is deleted at once and can’t be recovered; groups you own pass to the member who joined earliest.',
    terms: ['delete account', 'delete my account', 'remove account', 'close account', 'erase', 'delete my data', 'deactivate'],
  },
  {
    id: 'privacy',
    question: 'Who can see my notes?',
    answer: 'Your notes are private to you. They, your photos, quiz answers and tutor messages are sent to AI providers to make your study materials, so don’t upload sensitive personal information. Settings (#settings) controls whether you appear in search and who can send friend requests.',
    terms: ['privacy', 'private', 'who can see', 'share', 'shared', 'data', 'safe', 'personal information', 'search'],
  },
  {
    id: 'feedback',
    question: 'How do I report a bug or send feedback?',
    answer: 'Open Help & feedback in Settings (#settings?help) and use the Send feedback form, or email officialbindet@gmail.com.',
    terms: ['bug', 'feedback', 'report', 'problem', 'broken', 'contact', 'support', 'idea', 'suggestion', 'email'],
  },
  {
    id: 'quick-menu',
    question: 'Is there a quick way to jump to a page?',
    answer: 'Press Ctrl+K (Cmd+K on a Mac) to open the quick menu, then type where you want to go or what you want to do.',
    terms: ['shortcut', 'keyboard', 'ctrl k', 'cmd k', 'quick menu', 'jump', 'navigate', 'find page', 'command'],
  },
  {
    id: 'help-limits',
    question: 'How many questions can I ask here?',
    answer: 'Suggested questions and anything I can match here are free. Other questions use a small AI helper: 5 a day and 3 an hour. For schoolwork, ask Otto (#tutor).',
    terms: ['limit', 'how many questions', 'help bot', 'this bot', 'remaining', 'quota'],
  },
]

export const SUGGESTED_HELP = ['photo-notes', 'flashcards', 'review', 'join-group', 'delete-account']

const STOP = new Set('a an the i me my we our you your it its is are was be do does did can could how what whats where when why who which to of in on at for with and or from this that there here please get got use using bindet bindit app'.split(' '))

/* Word endings folded so "uploading", "uploads" and "uploaded" all read as "upload". */
function stem(word: string) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

const SYNONYMS: Record<string, string> = {
  pic: 'photo', pics: 'photo', picture: 'photo', image: 'photo', images: 'photo', snap: 'photo',
  flashcard: 'flashcard', flash: 'flashcard', card: 'flashcard', cards: 'flashcard',
  erase: 'delete', remov: 'delete', remove: 'delete', deactivate: 'delete',
  notif: 'notification', todo: 'task', homework: 'task', assignment: 'task',
  teammate: 'group', team: 'group', class: 'course', subject: 'course',
}

export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9#+\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => SYNONYMS[word] ?? SYNONYMS[stem(word)] ?? stem(word))
}

function termWords(term: string) {
  return normalizeWords(term).filter((word) => !STOP.has(word))
}

/* Each entry's terms, normalized once. */
const INDEX = HELP_FAQ.map((entry) => {
  const seen = new Set<string>()
  const terms = [...entry.terms.map(termWords), termWords(entry.question)].filter((words) => {
    const key = words.join(' ')
    if (!words.length || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { entry, terms }
})

export type HelpMatch = { entry: HelpEntry; score: number }

/*
 * Scores every entry: a term whose words all appear in the question counts 1 per word
 * (so phrases count more), and the entry's own question counts too. A match is
 * confident only when it is at least a full point ahead of the next best; a tie goes
 * to the server (or nowhere) rather than to a guess.
 */
export function matchHelp(question: string): HelpMatch | null {
  const words = new Set(normalizeWords(question).filter((word) => !STOP.has(word)))
  if (!words.size) return null
  let best: HelpMatch | null = null
  let second = 0
  for (const { entry, terms } of INDEX) {
    let score = 0
    for (const term of terms) {
      if (term.every((word) => words.has(word))) score += term.length === 1 ? 1 : term.length * 1.5
    }
    if (!best || score > best.score) {
      second = best?.score ?? 0
      best = { entry, score }
    } else if (score > second) {
      second = score
    }
  }
  if (!best || best.score < 1 || best.score - second < 1) return null
  return best
}

export function helpEntry(id: string) {
  return HELP_FAQ.find((entry) => entry.id === id) ?? null
}

/* Greetings and thanks get a friendly local reply instead of a request. */
const SMALL_TALK = /^(hi+|hello|hey+|yo|sup|thanks?|thank you|thx|ok(ay)?|cool|nice|bye|good (morning|night|evening))\W*$/i
export function isSmallTalk(question: string) {
  return SMALL_TALK.test(question.trim())
}

export type HelpUsage = { daily_limit: number; hourly_limit: number; remaining_today: number | null; remaining_this_hour: number | null }
export type HelpReply = HelpUsage & { answer: string; source: 'ai' | 'cache' | 'off_topic' | 'blocked' }

export function getHelpUsage(accessToken?: string, signal?: AbortSignal) {
  return request<HelpUsage>('/api/help-bot', { signal, timeoutMs: 8000 }, accessToken)
}

export function askHelpBot(question: string, accessToken?: string, signal?: AbortSignal) {
  return request<HelpReply>('/api/help-bot', { method: 'POST', body: JSON.stringify({ question: question.slice(0, HELP_QUESTION_MAX) }), signal, timeoutMs: 15000 }, accessToken)
}

export type HelpPiece = { text: string } | { email: string }
export type HelpAnswer = { pieces: HelpPiece[]; links: { href: string; label: string }[] }

/*
 * An answer as text plus the internal pages it points to. "(#tools)" is taken out of the
 * text and offered as a link under it; a bare "#tools" reads as the page's name. Only
 * pages in HELP_LINKS and the support email become links; nothing else does.
 */
export function parseAnswer(answer: string): HelpAnswer {
  const links: { href: string; label: string }[] = []
  const add = (hash: string) => {
    if (!links.some((link) => link.href === hash)) links.push({ href: hash, label: HELP_LINKS[hash] })
  }
  const text = answer
    .replace(/\s?\((#[a-z]+(?:\?[a-z]+)?)\)/gi, (_match, hash: string) => {
      const key = hash.toLowerCase()
      if (!(key in HELP_LINKS)) return ''
      add(key)
      return ''
    })
    .replace(/#[a-z]+(?:\?[a-z]+)?/gi, (hash) => {
      const key = hash.toLowerCase()
      if (!(key in HELP_LINKS)) return hash.slice(1)
      add(key)
      return HELP_LINKS[key]
    })
  const pieces: HelpPiece[] = []
  let last = 0
  const email = new RegExp(HELP_EMAIL.replace(/[.@]/g, '\\$&'), 'gi')
  for (const match of text.matchAll(email)) {
    const index = match.index ?? 0
    if (index > last) pieces.push({ text: text.slice(last, index) })
    pieces.push({ email: HELP_EMAIL })
    last = index + match[0].length
  }
  if (last < text.length) pieces.push({ text: text.slice(last) })
  return { pieces, links }
}
