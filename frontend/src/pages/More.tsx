import { useState, type FormEvent, type ReactNode } from 'react'
import { Icons } from '../components/Icons'
import type { AuthSession } from '../lib/auth'
import { describeDevice, sendFeedback, type FeedbackCategory } from '../lib/practiceLab'
import { pageBeforeHelp } from '../lib/screens'
import { toneClass, type Tone } from '../lib/tones'
import './More.css'

/* Help: short guides written from what bindet actually does, and a way to send feedback. */

type Guide = { id: string; title: string; summary: string; tone: Tone; icon: ReactNode; body: ReactNode }

const GUIDES: Guide[] = [
  {
    id: 'notes',
    title: 'Add notes',
    summary: 'Upload a file, paste text, or take a photo.',
    tone: 'blue',
    icon: Icons.sparkle,
    body: (
      <ol className="help__steps">
        <li>Open <a href="#tools">Study</a> and pick a course, then a unit. If you have none yet, create a course and add a unit for each topic or chapter.</li>
        <li><b>Upload a file:</b> PDF, DOCX, TXT, Markdown, CSV or JSON, or a photo of handwritten notes, up to 4 MB.</li>
        <li><b>Paste or type notes:</b> paste your text, then choose <b>Add typed notes</b>. Typed text isn’t saved until you do.</li>
        <li><b>Take a photo of your notes:</b> handwritten or printed. Each photo becomes its own note, and <b>Add another page</b> adds the next one.</li>
        <li>bindet reads the text out of each note, then makes its flashcards for you. You can remove a note from the unit’s note list at any time.</li>
      </ol>
    ),
  },
  {
    id: 'flashcards',
    title: 'Flashcards',
    summary: 'Made for you from each note, saved, and easy to remake.',
    tone: 'violet',
    icon: Icons.target,
    body: (
      <ol className="help__steps">
        <li><b>Automatic:</b> when you add a note, its flashcards are written from that note only and saved. Opening them again later doesn’t make new ones.</li>
        <li>Switch the unit to <b>Flashcards</b>. Click a card or press <kbd>Space</kbd> to flip it, and use <kbd>←</kbd> <kbd>→</kbd> to move between cards.</li>
        <li><b>Review:</b> switch the flashcards from <b>Browse</b> to <b>Review</b>. Show the answer, then rate it <b>Again</b>, <b>Hard</b>, <b>Good</b> or <b>Easy</b> (keys <kbd>1</kbd>–<kbd>4</kbd>). Cards you know come back later, and cards you miss come back sooner. Home shows how many are due.</li>
        <li><b>Instructions (optional):</b> type something like “focus on vocabulary” or “make them harder”, then choose <b>Make new cards with these instructions</b>. That replaces the cards for the notes in this unit; your saved cards only change when you do this.</li>
        <li><b>Focus mode:</b> the <b>Focus</b> button gives you large text and fewer distractions. Use A− and A+ to change the text size, and <kbd>Esc</kbd> to leave.</li>
        <li>Very short notes may be too short for flashcards. Add longer notes or paste more text.</li>
      </ol>
    ),
  },
  {
    id: 'quiz',
    title: 'Quiz',
    summary: 'Questions from your notes at three levels.',
    tone: 'green',
    icon: Icons.check,
    body: (
      <ol className="help__steps">
        <li>Switch the unit to <b>Quiz</b>. Questions come from the notes in that unit; with no notes yet, they’re based on the unit’s name.</li>
        <li>Pick <b>Level 1</b>, <b>2</b> or <b>3</b>, then <b>New question</b>. While a question is open the same button says <b>Skip</b>.</li>
        <li>Answer by picking a choice or typing. bindet checks it, explains the answer, and gives a hint when you’re not there yet, so you can try again.</li>
        <li>A right answer on the first try earns 10 XP, and 5 XP after a retry.</li>
        <li><b>Instructions (optional)</b> shape your next questions in this unit, for example “only ask about dates”.</li>
        <li>Stuck? <b>Ask Otto about this</b> opens the question with Otto.</li>
        <li><b>Practice test:</b> choose <b>Take a practice test</b> on the Quiz panel, or <b>Test the whole course</b>. Pick 5, 10 or 15 questions, timed or untimed. After you submit you see your score, which topics need work, and every answer explained.</li>
      </ol>
    ),
  },
  {
    id: 'tutor',
    title: 'Otto, the tutor',
    summary: 'What it will and won’t help with.',
    tone: 'teal',
    icon: Icons.message,
    body: (
      <>
        <ol className="help__steps">
          <li>In <a href="#tutor">Otto</a>, the tutor, pick a course and unit so answers use your notes first. When it relies on a note, it names the file.</li>
          <li>You can attach up to 3 images (JPG, PNG, WebP or GIF), like a photo of a problem.</li>
        </ol>
        <div className="help__columns">
          <div>
            <h4 className="help__subhead">It will help you</h4>
            <ul className="help__bullets">
              <li>understand your notes and course material</li>
              <li>work through homework, with steps and a check question rather than just the final answer</li>
              <li>prepare for exams and build study skills</li>
              <li>quiz you on a topic</li>
            </ul>
          </div>
          <div>
            <h4 className="help__subhead">It won’t</h4>
            <ul className="help__bullets">
              <li>do things unrelated to studying, like personal or relationship advice, or writing and code that have nothing to do with schoolwork</li>
              <li>help with anything harmful</li>
              <li>change its role or reveal its instructions</li>
            </ul>
          </div>
        </div>
        <p className="help__note">Otto can make mistakes, so check anything important. It has hourly and daily message limits.</p>
      </>
    ),
  },
  {
    id: 'groups',
    title: 'Tasks and study groups',
    summary: 'Owners, transferring, and deleting.',
    tone: 'orange',
    icon: Icons.users,
    body: (
      <ol className="help__steps">
        <li><a href="#goals">Tasks</a> holds your own tasks and your groups’ tasks, as a list, a board, or a calendar.</li>
        <li>In <a href="#profile">Friends &amp; groups</a>, create a study group or join one with its invite code. You can be in up to 5 groups, and a group holds up to 20 people.</li>
        <li><b>Group tasks:</b> the person who created a task, its assignees and the group owner can update it. Only the creator or the group owner can change its title, due date, assignees, milestone or group.</li>
        <li><b>Transfer ownership:</b> the owner can hand the group to another member, who then manages its tasks and is the only one who can delete it. You stay in the group as a member.</li>
        <li><b>Delete a group:</b> only the owner can, after typing the group’s name. Its tasks aren’t lost: each becomes a personal task of the person who created it.</li>
        <li><b>Leaving:</b> members can leave at any time. An owner transfers the group first, unless they’re the only member, in which case leaving deletes it.</li>
      </ol>
    ),
  },
  {
    id: 'practice',
    title: 'Practice lab',
    summary: 'Timed rounds, personal bests and challenges.',
    tone: 'pink',
    icon: Icons.bolt,
    body: (
      <ol className="help__steps">
        <li>Open <a href="#games">Practice lab</a>, pick a course and a unit (or all units), and a length of 1, 2 or 5 minutes. Rounds use the flashcards you’ve already saved, so nothing waits on the AI.</li>
        <li><b>Self-check:</b> press <kbd>Space</kbd> to see the answer, then <kbd>J</kbd> if you got it or <kbd>K</kbd> if you missed it (or <kbd>1</kbd> and <kbd>2</kbd>). <b>Multiple choice</b> (units with 4 or more cards) shows four answers; press <kbd>1</kbd> to <kbd>4</kbd>.</li>
        <li>Each right answer is a point, and from 5 in a row each one counts double. A round earns up to 15 XP, and rounds earn up to 50 XP a day.</li>
        <li><b>Personal bests</b> are kept for each unit, length and answer mode. The end screen shows what you missed, with a quick way to practice those cards again.</li>
        <li><b>Challenge a friend:</b> pick a friend or someone in one of your study groups. They play the same cards (up to 30) in the same order and time. The question and answer text of those cards is shared with that person only; your notes stay private. They have 7 days to play, or they can decline.</li>
      </ol>
    ),
  },
  {
    id: 'privacy',
    title: 'Privacy and deleting your account',
    summary: 'What is shared, and how to delete everything.',
    tone: 'amber',
    icon: Icons.info,
    body: (
      <ol className="help__steps">
        <li>Your notes, photos, quiz answers and tutor messages are sent to AI providers to make your study materials, so please don’t upload sensitive personal information.</li>
        <li>Group chats are private to the group’s members. In <a href="#settings">Settings</a>, choose whether you appear in search and whether new people can send you friend requests. You can block or report someone from Friends &amp; groups.</li>
        <li><b>Delete your account:</b> in <a href="#settings">Settings</a>, choose <b>Delete account</b> and type <b>DELETE MY ACCOUNT</b>. For your safety you may be asked to sign in again first.</li>
        <li>Everything in your account is deleted at once and can’t be recovered, including practice rounds and challenges you sent or received. Groups you own pass to the member who joined earliest; a group where you’re the only member is deleted.</li>
        <li>Read the <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Service</a>, or email <a href="mailto:officialbindet@gmail.com">officialbindet@gmail.com</a> for a copy of your data.</li>
      </ol>
    ),
  },
]

const CATEGORIES: { id: FeedbackCategory; label: string }[] = [
  { id: 'bug', label: 'Bug' },
  { id: 'idea', label: 'Idea' },
  { id: 'other', label: 'Other' },
]
const MESSAGE_MAX = 2000

export function More({ session }: { session?: AuthSession | null }) {
  return (
    <div className="ui-page help">
      <header className="ui-page-header">
        <div>
          <span className="ui-eyebrow">Help</span>
          <h1 className="ui-page-title">How bindet works</h1>
          <p className="ui-page-subtitle">bindet keeps your schoolwork in one binder: notes sorted by course and unit, practice made from those notes, and the people you study with.</p>
        </div>
      </header>

      <section className="ui-section" aria-labelledby="help-guides">
        <div className="ui-section-head"><h2 className="ui-section-title" id="help-guides">Guides</h2></div>
        <div className="ui-panel help__guides">
          {GUIDES.map((guide) => (
            <details key={guide.id} className={`help__guide ${toneClass(guide.tone)}`} id={`guide-${guide.id}`}>
              <summary>
                <span className="ui-icon" aria-hidden="true">{guide.icon}</span>
                <span className="help__guide-text">
                  <span className="help__guide-title">{guide.title}</span>
                  <span className="help__guide-summary">{guide.summary}</span>
                </span>
                <svg className="help__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </summary>
              <div className="help__guide-body">{guide.body}</div>
            </details>
          ))}
        </div>
      </section>

      <section className="ui-section" aria-labelledby="help-feedback">
        <div className="ui-section-head"><h2 className="ui-section-title" id="help-feedback">Send feedback</h2></div>
        <FeedbackForm session={session ?? null} />
      </section>
    </div>
  )
}

function FeedbackForm({ session }: { session: AuthSession | null }) {
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  const [message, setMessage] = useState('')
  const [includeDevice, setIncludeDevice] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const page = pageBeforeHelp()

  if (!session) {
    return <div className="ui-panel ui-panel--padded help__feedback"><p className="help__note">Sign in to send feedback, or email <a href="mailto:officialbindet@gmail.com">officialbindet@gmail.com</a>.</p></div>
  }

  if (sent) {
    return (
      <div className="ui-panel ui-panel--padded help__feedback help__thanks ui-tone--green" role="status">
        <span className="ui-icon" aria-hidden="true">{Icons.check}</span>
        <div>
          <p className="help__thanks-title">Thanks — the bindet team reads every message.</p>
          <p className="help__note">You can also email <a href="mailto:officialbindet@gmail.com">officialbindet@gmail.com</a>.</p>
          <button type="button" className="ui-button ui-button--sm" onClick={() => { setSent(false); setMessage('') }}>Send another</button>
        </div>
      </div>
    )
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!message.trim() || busy || !session) return
    setBusy(true)
    setError('')
    try {
      await sendFeedback({
        category,
        message: message.trim(),
        ...(includeDevice ? { device: describeDevice(), page } : {}),
      }, session.access_token)
      setSent(true)
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : 'Your feedback couldn’t be sent. Try again.')
    }
    setBusy(false)
  }

  const device = includeDevice ? describeDevice() : null

  return (
    <form className="ui-panel ui-panel--padded help__feedback" onSubmit={(event) => void submit(event)}>
      <p className="help__note">Tell us what to fix or build next. Or email <a href="mailto:officialbindet@gmail.com">officialbindet@gmail.com</a>.</p>
      <div className="help__field">
        <span className="help__label" id="feedback-kind">What is it about?</span>
        <div className="ui-segmented help__kinds" role="group" aria-labelledby="feedback-kind">
          {CATEGORIES.map((item) => (
            <button key={item.id} type="button" className="ui-segmented__item" aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.label}</button>
          ))}
        </div>
      </div>
      <label className="ui-field">
        <span>Message</span>
        <textarea
          className="ui-textarea help__message"
          value={message}
          maxLength={MESSAGE_MAX}
          rows={5}
          required
          placeholder={category === 'bug' ? 'What happened, and what did you expect?' : category === 'idea' ? 'What would make bindet better for you?' : 'What’s on your mind?'}
          onChange={(event) => setMessage(event.target.value)}
        />
        <span className={`help__count${message.length >= MESSAGE_MAX ? ' is-full' : ''}`}>{message.length}/{MESSAGE_MAX}</span>
      </label>
      <label className="help__check">
        <input className="ui-checkbox" type="checkbox" checked={includeDevice} onChange={(event) => setIncludeDevice(event.target.checked)} />
        <span>
          Include my device info
          <small>Browser, operating system, screen size{page ? ' and the page you were on' : ''}. Nothing else.</small>
        </span>
      </label>
      {device ? (
        <p className="help__device">{[device.browser, device.os, `screen ${device.screen}`, `window ${device.viewport}`, page ? `page: ${page}` : ''].filter(Boolean).join(' · ')}</p>
      ) : null}
      {error ? <div className="ui-alert" role="alert"><span>{error}</span></div> : null}
      <div>
        <button type="submit" className={`ui-button ui-button--primary${busy ? ' is-busy' : ''}`} disabled={!message.trim() || busy}>Send feedback</button>
      </div>
    </form>
  )
}
