import type { AnswerResult, Flashcard, FriendsHub, GeneratedQuestion, Profile, Progress, StudyGroup } from '../../lib/api'
import type { AuthSession } from '../../lib/auth'
import type { DataSource } from '../../lib/dataSource'
import { COURSE_TONES } from '../../lib/session'
import type { Notebook, UnitAttempt } from '../../lib/types'

/*
 * Sandboxed data for the landing page's live demo. Everything lives in memory
 * for the lifetime of one preview: no network requests, no browser storage.
 * Anything that would create, upload, delete or save calls onLocked instead.
 */

const DAY = 86_400_000
// A fixed moment so the demo never depends on the visitor's clock. Noon UTC keeps the same
// calendar date from UTC−11 to UTC+11; the greeting hour is pinned separately below.
export const DEMO_NOW = Date.UTC(2026, 8, 15, 12, 0)
const DEMO_HOUR = 15
const iso = (daysAgo: number) => new Date(DEMO_NOW - daysAgo * DAY).toISOString()

export const DEMO_STUDENT = 'demo-student'
export const DEMO_SESSION: AuthSession = {
  access_token: 'demo',
  refresh_token: 'demo',
  expires_at: Math.floor(DEMO_NOW / 1000) + 3600,
  user: { id: DEMO_STUDENT, email: 'maya@demo.bindit' },
}

export type UnitContent = {
  preview: string
  file: string
  cards: [string, string][]
  questions: { q: string; choices: string[]; answer: string; why: string; hint: string }[]
}

const COURSES: { name: string; tone: string; units: Record<string, UnitContent> }[] = [
  {
    name: 'AP Biology',
    tone: COURSE_TONES[0],
    units: {
      Genetics: {
        file: 'punnett-squares-lecture.pdf',
        preview: 'Dominant and recessive alleles, Punnett squares, and how to predict offspring ratios.',
        cards: [
          ['What is an allele?', 'A version of a gene. You inherit one allele from each parent.'],
          ['What ratio does a cross of two heterozygotes (Aa × Aa) give?', '3 : 1 dominant to recessive phenotypes (1 AA : 2 Aa : 1 aa genotypes).'],
          ['Genotype vs. phenotype?', 'Genotype is the allele combination; phenotype is the trait you can observe.'],
          ['What does homozygous mean?', 'Both alleles for a gene are the same, like AA or aa.'],
        ],
        questions: [
          { q: 'Two heterozygous pea plants (Aa × Aa) are crossed. What fraction of the offspring show the recessive trait?', choices: ['1/4', '1/2', '3/4', 'None'], answer: '1/4', why: 'Only aa offspring show the recessive trait, and a Punnett square gives aa in 1 of 4 boxes.', hint: 'Draw the 2 × 2 square and count the boxes with two lowercase letters.' },
          { q: 'Which term describes an organism with genotype BB?', choices: ['Homozygous dominant', 'Heterozygous', 'Homozygous recessive', 'Codominant'], answer: 'Homozygous dominant', why: 'Two identical dominant alleles make it homozygous dominant.', hint: 'Homo means same; check whether the letters are uppercase.' },
          { q: 'A trait you can observe, like flower color, is the organism’s…', choices: ['Phenotype', 'Genotype', 'Allele', 'Locus'], answer: 'Phenotype', why: 'The phenotype is the observable trait that results from the genotype.', hint: 'One word is about the letters, the other about what you see.' },
        ],
      },
      Cells: {
        file: 'cell-membrane-notes.jpg',
        preview: 'The cell membrane is selectively permeable and regulates what enters and leaves the cell.',
        cards: [
          ['What does “selectively permeable” mean?', 'The membrane lets some substances through and blocks others.'],
          ['Where is ATP mostly made?', 'In the mitochondria, during cellular respiration.'],
          ['What does a hypertonic solution do to a cell?', 'Water leaves the cell, so it shrinks.'],
        ],
        questions: [
          { q: 'A red blood cell is placed in a hypertonic solution. What happens?', choices: ['It shrinks', 'It swells and bursts', 'Nothing changes', 'It divides'], answer: 'It shrinks', why: 'Water moves out toward the higher solute concentration, so the cell loses volume.', hint: 'Water moves toward where there are more dissolved particles.' },
          { q: 'Which organelle produces most of a cell’s ATP?', choices: ['Mitochondria', 'Ribosome', 'Golgi apparatus', 'Nucleus'], answer: 'Mitochondria', why: 'Cellular respiration in the mitochondria produces most ATP.', hint: 'It is often called the powerhouse of the cell.' },
          { q: 'What controls what enters and leaves the cell?', choices: ['Cell membrane', 'Cell wall', 'Cytoplasm', 'Chromosome'], answer: 'Cell membrane', why: 'The selectively permeable cell membrane regulates transport.', hint: 'It is the boundary every cell has.' },
        ],
      },
      Evolution: {
        file: 'natural-selection.pdf',
        preview: 'Variation, inheritance, and selection pressure drive changes in populations over time.',
        cards: [
          ['What is natural selection?', 'Individuals with helpful inherited traits survive and reproduce more, so those traits spread.'],
          ['What is an adaptation?', 'An inherited trait that improves survival or reproduction in an environment.'],
          ['Does evolution act on individuals or populations?', 'Populations. Individuals don’t evolve; allele frequencies in populations change.'],
        ],
        questions: [
          { q: 'Natural selection acts directly on an organism’s…', choices: ['Phenotype', 'Genotype only', 'Future offspring', 'Species name'], answer: 'Phenotype', why: 'Selection acts on traits that affect survival, which are expressed phenotypes.', hint: 'The environment can only “see” observable traits.' },
          { q: 'What evolves over generations?', choices: ['Populations', 'Individual organisms', 'Single cells only', 'Ecosystems only'], answer: 'Populations', why: 'Evolution is a change in allele frequencies in a population over time.', hint: 'Think about groups, not one organism.' },
          { q: 'Which is required for natural selection?', choices: ['Inherited variation', 'Identical individuals', 'No competition', 'Unlimited resources'], answer: 'Inherited variation', why: 'Without inherited differences, there is nothing for selection to favor.', hint: 'Selection needs differences to choose between.' },
        ],
      },
    },
  },
  {
    name: 'Chemistry',
    tone: COURSE_TONES[1],
    units: {
      Stoichiometry: {
        file: 'mole-ratios-worksheet.docx',
        preview: 'Balanced equations give mole ratios, which convert between reactants and products.',
        cards: [
          ['What is a mole ratio?', 'The ratio of coefficients in a balanced equation, used to convert between substances.'],
          ['How many particles are in one mole?', '6.022 × 10²³ (Avogadro’s number).'],
          ['What is the limiting reactant?', 'The reactant that runs out first and caps how much product forms.'],
        ],
        questions: [
          { q: 'In 2H₂ + O₂ → 2H₂O, how many moles of water form from 4 moles of H₂?', choices: ['4', '2', '8', '1'], answer: '4', why: 'H₂ and H₂O are in a 2 : 2 ratio, so 4 mol H₂ makes 4 mol H₂O.', hint: 'Compare the coefficients in front of H₂ and H₂O.' },
          { q: 'The reactant that is used up first is called the…', choices: ['Limiting reactant', 'Excess reactant', 'Catalyst', 'Product'], answer: 'Limiting reactant', why: 'It limits the amount of product that can form.', hint: 'It sets the limit.' },
          { q: 'How many particles are in 1 mole?', choices: ['6.022 × 10²³', '1 × 10²³', '6.022 × 10²⁰', '100'], answer: '6.022 × 10²³', why: 'That is Avogadro’s number.', hint: 'It is Avogadro’s number.' },
        ],
      },
      Atoms: {
        file: 'periodic-trends.pdf',
        preview: 'Atomic radius decreases across a period and increases down a group.',
        cards: [
          ['How does atomic radius change across a period?', 'It decreases, because more protons pull electrons closer.'],
          ['What determines an element’s identity?', 'Its number of protons (atomic number).'],
          ['What are isotopes?', 'Atoms of the same element with different numbers of neutrons.'],
        ],
        questions: [
          { q: 'Moving left to right across a period, atomic radius generally…', choices: ['Decreases', 'Increases', 'Stays the same', 'Doubles'], answer: 'Decreases', why: 'More protons increase nuclear charge and pull electrons in closer.', hint: 'Think about nuclear charge.' },
          { q: 'Atoms of the same element with different neutron counts are…', choices: ['Isotopes', 'Ions', 'Isomers', 'Allotropes'], answer: 'Isotopes', why: 'Isotopes share a proton count but differ in neutrons.', hint: 'Same element, different mass.' },
          { q: 'What defines which element an atom is?', choices: ['Number of protons', 'Number of neutrons', 'Number of electrons', 'Atomic mass'], answer: 'Number of protons', why: 'The atomic number, the proton count, identifies the element.', hint: 'It is the atomic number.' },
        ],
      },
    },
  },
  {
    name: 'US History',
    tone: COURSE_TONES[3],
    units: {
      Revolution: {
        file: 'causes-of-the-revolution.txt',
        preview: 'Taxation without representation, the Stamp Act, and growing colonial resistance.',
        cards: [
          ['What did the Stamp Act tax?', 'Printed materials like newspapers and legal documents.'],
          ['What was the Boston Tea Party protesting?', 'The Tea Act and taxation without representation.'],
          ['When was the Declaration of Independence adopted?', 'July 4, 1776.'],
        ],
        questions: [
          { q: 'The 1765 Stamp Act taxed…', choices: ['Printed materials', 'Tea', 'Sugar', 'Imported glass'], answer: 'Printed materials', why: 'It required a tax stamp on newspapers, legal papers and other printed goods.', hint: 'Think about what needed a stamp.' },
          { q: 'The slogan “no taxation without representation” objected to…', choices: ['Taxes passed without colonial seats in Parliament', 'All taxes', 'State taxes', 'Taxes on land'], answer: 'Taxes passed without colonial seats in Parliament', why: 'Colonists had no representatives in Parliament voting on their taxes.', hint: 'Focus on the word representation.' },
          { q: 'The Declaration of Independence was adopted in…', choices: ['1776', '1765', '1783', '1789'], answer: '1776', why: 'The Continental Congress adopted it on July 4, 1776.', hint: 'The country celebrates it every July 4.' },
        ],
      },
      'Colonial era': {
        file: 'jamestown-reading.pdf',
        preview: 'Jamestown, founded in 1607, became the first permanent English settlement in America.',
        cards: [
          ['When was Jamestown founded?', '1607.'],
          ['What cash crop saved Jamestown?', 'Tobacco.'],
          ['What was the Mayflower Compact?', 'An early agreement for self-government signed by Plymouth settlers in 1620.'],
        ],
        questions: [
          { q: 'Jamestown was founded in…', choices: ['1607', '1620', '1492', '1776'], answer: '1607', why: 'Jamestown was established in 1607 in Virginia.', hint: 'It came before the Mayflower (1620).' },
          { q: 'Which crop made Jamestown profitable?', choices: ['Tobacco', 'Cotton', 'Wheat', 'Rice'], answer: 'Tobacco', why: 'John Rolfe’s tobacco became the colony’s cash crop.', hint: 'It was exported to England in huge amounts.' },
          { q: 'The Mayflower Compact is an early example of…', choices: ['Self-government', 'A trade treaty', 'A tax law', 'A royal charter'], answer: 'Self-government', why: 'The settlers agreed to make and follow their own laws.', hint: 'Who made the rules?' },
        ],
      },
    },
  },
  {
    name: 'Algebra II',
    tone: COURSE_TONES[2],
    units: {
      Logarithms: {
        file: 'log-rules.md',
        preview: 'Product, quotient and power rules, and converting between log and exponential form.',
        cards: [
          ['log_b(xy) = ?', 'log_b(x) + log_b(y).'],
          ['What is log₂(8)?', '3, because 2³ = 8.'],
          ['Rewrite log_b(x) = y in exponential form.', 'b^y = x.'],
        ],
        questions: [
          { q: 'What is log₂(32)?', choices: ['5', '4', '6', '16'], answer: '5', why: '2⁵ = 32, so log₂(32) = 5.', hint: 'Which power of 2 makes 32?' },
          { q: 'log(x) + log(y) equals…', choices: ['log(xy)', 'log(x + y)', 'log(x) · log(y)', 'log(x / y)'], answer: 'log(xy)', why: 'The product rule turns a sum of logs into the log of a product.', hint: 'Adding logs matches multiplying inside.' },
          { q: 'log₃(x) = 2 means x equals…', choices: ['9', '6', '8', '5'], answer: '9', why: 'In exponential form, 3² = x, so x = 9.', hint: 'Rewrite it as a power of 3.' },
        ],
      },
      Functions: {
        file: 'function-transformations.docx',
        preview: 'Shifts, stretches and reflections of parent functions.',
        cards: [
          ['What does f(x) + 3 do to a graph?', 'Shifts it up 3 units.'],
          ['What does f(x − 2) do?', 'Shifts it right 2 units.'],
          ['What does −f(x) do?', 'Reflects it across the x-axis.'],
        ],
        questions: [
          { q: 'The graph of f(x − 4) is f(x) shifted…', choices: ['Right 4', 'Left 4', 'Up 4', 'Down 4'], answer: 'Right 4', why: 'Subtracting inside the function moves the graph right.', hint: 'Changes inside the parentheses act on x, and feel backwards.' },
          { q: 'Which reflects f(x) across the x-axis?', choices: ['−f(x)', 'f(−x)', 'f(x) − 1', '2f(x)'], answer: '−f(x)', why: 'Negating the output flips every y-value.', hint: 'Flip the outputs, not the inputs.' },
          { q: 'f(x) + 5 moves the graph…', choices: ['Up 5', 'Right 5', 'Down 5', 'Left 5'], answer: 'Up 5', why: 'Adding outside the function raises every output by 5.', hint: 'Outside changes affect y.' },
        ],
      },
    },
  },
]

/* Read-only view of the demo courses, so the landing page's story sections show the same material as the live demo. */
export const DEMO_COURSES: readonly { name: string; tone: string; units: Readonly<Record<string, Readonly<UnitContent>>> }[] = COURSES

export const DEMO_SUMMARY = {
  courses: COURSES.length,
  notes: COURSES.reduce((sum, course) => sum + Object.keys(course.units).length, 0),
  streak: 12,
  xp: 2480,
}

function initialNotebook(): Notebook {
  return {
    courses: COURSES.map((course) => ({ name: course.name, tone: course.tone, units: Object.keys(course.units) })),
    activeCourse: 'AP Biology',
    activeUnit: 'Genetics',
    deposits: COURSES.flatMap((course, c) =>
      Object.entries(course.units).map(([unit, content], u) => ({
        id: `demo-${c}-${u}`,
        course: course.name,
        unit,
        fileName: content.file,
        createdAt: iso(c * 2 + u * 1.5 + 0.2),
        status: 'ready' as const,
        textPreview: content.preview,
      })),
    ),
  }
}

function initialAttempts(): UnitAttempt[] {
  const plan: [string, string, boolean[]][] = [
    ['AP Biology', 'Cells', [true, false, ...Array<boolean>(22).fill(true)]],
    ['AP Biology', 'Genetics', [false, true, false, true, true, false, true, true]],
    ['Chemistry', 'Stoichiometry', [false, false, true, false, true, false]],
    ['Chemistry', 'Atoms', [true, true, true, false, true, true, true]],
    ['US History', 'Revolution', [true, false, true, true, true]],
    ['Algebra II', 'Logarithms', [true, false, false, true, true, true, false, true]],
  ]
  return plan.flatMap(([course, unit, results], p) =>
    results.map((correct, i) => ({ id: `a-${p}-${i}`, course, unit, correct, at: DEMO_NOW - (results.length - i) * DAY * 0.6 })),
  )
}

const friend = (id: string, name: string, username: string, weekly: number, active = true) => ({
  student_id: id, username, display_name: name, avatar_path: '', total_xp: weekly * 9, streak: 6, active_today: active, weekly_xp: weekly, friend_streak: 4,
})

function findContent(course: string, unit: string): UnitContent {
  const match = COURSES.find((item) => item.name === course)?.units[unit]
  if (match) return match
  // Never leave a unit empty, even for a combination the demo does not know about.
  return COURSES[0].units.Genetics
}

export function createDemoData(onLocked: (action: string) => void): DataSource {
  let notebook = initialNotebook()
  const attempts = initialAttempts()
  const questionTurn = new Map<string, number>()
  const issued = new Map<string, { answer: string; why: string; hint: string }>()
  const stats: Progress = {
    student_id: DEMO_STUDENT, total_xp: 2480, attempts: 214, correct_answers: 180, accuracy: 84.1,
    streak: 5, best_streak: 11, login_streak: 12, best_login_streak: 12, weak_topics: ['Stoichiometry'],
    topics: [{ topic: 'Stoichiometry', attempts: 22, correct_answers: 14, accuracy: 63.6 }],
  }
  const profile: Profile = {
    student_id: DEMO_STUDENT, username: 'maya_r', display_name: 'Maya Rodriguez', avatar_path: '', friend_code: 'BND-DEMO-2026',
    daily_goal: 30, discoverable: true, allow_friend_requests: true, total_xp: 2480, streak: 5, best_streak: 11, login_streak: 12, best_login_streak: 12,
  }
  const leaderboard = [
    friend('f1', 'Jordan Kim', 'jordank', 310),
    friend(DEMO_STUDENT, 'Maya Rodriguez', 'maya_r', 285),
    friend('f2', 'Priya Natarajan', 'priya_n', 240),
    friend('f3', 'Sam Rivera', 'samr', 120, false),
  ]
  const hub: FriendsHub = {
    friends: leaderboard.filter((item) => item.student_id !== DEMO_STUDENT),
    requests: [{ request_id: 1, username: 'alex_t', display_name: 'Alex Thompson', created_at: iso(1) }],
    leaderboard,
    quests: [{ id: 1, friend_id: 'f1', friend_name: 'Jordan Kim', target_xp: 100, progress_xp: 72, status: 'active', expires_at: iso(-2) }],
    suggestions: [{ student_id: 's1', username: 'lena_p', display_name: 'Lena Park', avatar_path: '', friend_code: 'BND-LENA-0007' }],
    activity: [
      { id: 1, student_id: 'f1', username: 'jordank', display_name: 'Jordan Kim', xp: 40, created_at: iso(0.1), reaction_count: 3, reacted: false },
      { id: 2, student_id: 'f2', username: 'priya_n', display_name: 'Priya Natarajan', xp: 25, created_at: iso(0.4), reaction_count: 1, reacted: true },
    ],
    notifications: [
      { id: 1, kind: 'friend_request', message: 'Alex Thompson sent you a friend request.', is_read: false, created_at: iso(1) },
      { id: 2, kind: 'quest', message: 'Jordan started a friend quest with you.', is_read: true, created_at: iso(2) },
    ],
  }
  const groups: StudyGroup[] = [
    {
      id: 'g1', name: 'AP Bio study circle', description: 'Weekly review before unit tests.', invite_code: 'BIO-DEMO', weekly_goal_xp: 600, weekly_xp: 455,
      role: 'owner', created_at: iso(20),
      members: [
        { student_id: DEMO_STUDENT, username: 'maya_r', display_name: 'Maya Rodriguez', avatar_path: '', role: 'owner', weekly_xp: 285, joined_at: iso(20) },
        { student_id: 'f2', username: 'priya_n', display_name: 'Priya Natarajan', avatar_path: '', role: 'member', weekly_xp: 170, joined_at: iso(12) },
      ],
      activity: [{ id: 1, student_id: 'f2', display_name: 'Priya Natarajan', xp: 25, created_at: iso(0.4) }],
    },
    {
      id: 'g2', name: 'Chem lab partners', description: 'Stoichiometry practice before the midterm.', invite_code: 'CHEM-DEMO', weekly_goal_xp: 400, weekly_xp: 210,
      role: 'member', created_at: iso(9),
      members: [
        { student_id: 'f1', username: 'jordank', display_name: 'Jordan Kim', avatar_path: '', role: 'owner', weekly_xp: 130, joined_at: iso(9) },
        { student_id: DEMO_STUDENT, username: 'maya_r', display_name: 'Maya Rodriguez', avatar_path: '', role: 'member', weekly_xp: 80, joined_at: iso(8) },
      ],
      activity: [{ id: 2, student_id: 'f1', display_name: 'Jordan Kim', xp: 40, created_at: iso(0.1) }],
    },
  ]

  const wait = <T,>(value: T, ms = 0) => new Promise<T>((resolve) => { setTimeout(() => resolve(value), ms) })
  const locked = (action: string) => () => {
    onLocked(action)
    return Promise.reject(new Error('Create a free account to do that.'))
  }

  return {
    sandboxed: true,
    getStudentId: () => DEMO_STUDENT,
    loadNotebook: () => structuredClone(notebook),
    saveNotebook: (next) => {
      // Only the selection is kept; the demo's courses, units and notes never change.
      const course = notebook.courses.find((item) => item.name === next.activeCourse)
      if (!course) return
      notebook = { ...notebook, activeCourse: course.name, activeUnit: course.units.includes(next.activeUnit) ? next.activeUnit : course.units[0] }
    },
    loadAvatar: () => '',
    saveAvatar: () => { onLocked('avatar') },
    loadUnitAttempts: () => attempts.slice(),
    recordUnitAttempt: (entry) => {
      attempts.push({ id: `live-${attempts.length}`, course: entry.course, unit: entry.unit, correct: entry.correct, at: DEMO_NOW + attempts.length * 1000 })
    },

    getProgress: () => wait(structuredClone(stats)),
    getCachedProgress: () => structuredClone(stats),
    getAccountProfile: () => wait(structuredClone(profile)),
    getCachedProfile: () => structuredClone(profile),
    getFriends: () => wait(structuredClone(hub)),
    getCachedFriends: () => structuredClone(hub),
    getStudyGroups: () => wait(structuredClone(groups)),
    getCachedStudyGroups: () => structuredClone(groups),

    generateFlashcards: (context) => {
      const content = findContent(context.course, context.unit)
      const cards: Flashcard[] = content.cards.map(([front, back]) => ({ front, back, topic: context.unit }))
      return wait({ course: context.course, unit: context.unit, personalized: true, cards }, 320)
    },
    generateQuestion: (_topic, difficulty, notes) => {
      const course = notes?.course ?? notebook.activeCourse
      const unit = notes?.unit ?? notebook.activeUnit
      const content = findContent(course, unit)
      const key = `${course}|${unit}`
      const turn = questionTurn.get(key) ?? 0
      questionTurn.set(key, turn + 1)
      const item = content.questions[turn % content.questions.length]
      const id = `demo-q-${key}-${turn}`
      issued.set(id, { answer: item.answer, why: item.why, hint: item.hint })
      const question: GeneratedQuestion = { question_id: id, question: item.q, topic: unit, difficulty, choices: item.choices }
      return wait(question, 260)
    },
    analyzeAnswer: (question, studentAnswer) => {
      const key = issued.get(question.question_id)
      // Exact match, ignoring case and spacing. Symbols matter: “−f(x)” and “f(−x)” are different answers.
      const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()
      const correct = Boolean(key && normalize(studentAnswer) === normalize(key.answer))
      const earned = correct ? 10 : 2
      stats.total_xp += earned
      profile.total_xp = stats.total_xp
      stats.attempts += 1
      if (correct) stats.correct_answers += 1
      stats.accuracy = Math.round((stats.correct_answers / stats.attempts) * 1000) / 10
      stats.streak = correct ? stats.streak + 1 : 0
      const result: AnswerResult = {
        correct,
        score: correct ? 1 : 0,
        mistake_type: correct ? null : 'concept',
        misconception: null,
        explanation: key ? (correct ? key.why : `The answer is ${key.answer}. ${key.why}`) : 'Nice try.',
        hint: correct || !key ? null : key.hint,
        grading_source: 'deterministic',
        xp_earned: earned,
        total_xp: stats.total_xp,
        streak: stats.streak,
      }
      return wait(result, 280)
    },

    uploadNote: locked('upload notes'),
    deleteNote: locked('remove notes'),
    answerFriendRequest: locked('answer friend requests'),
    blockSocialUser: locked('manage friends'),
    createStudyGroup: locked('create a study group'),
    joinStudyGroup: locked('join a study group'),
    leaveStudyGroup: locked('manage study groups'),
    reactToActivity: locked('react to activity'),
    readSocialNotifications: locked('manage notifications'),
    removeFriend: locked('manage friends'),
    reportSocialUser: locked('manage friends'),
    saveSocialPrivacy: locked('change privacy settings'),
    searchFriends: locked('find friends'),
    sendFriendRequest: locked('add friends'),
    startFriendQuest: locked('start a friend quest'),

    now: () => DEMO_NOW,
    hourOf: () => DEMO_HOUR,
    confirm: () => false,
  }
}
