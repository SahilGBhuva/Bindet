import { ComingSoonCards, Icons } from '../components/ComingSoonCards'
import './Placeholder.css'

/* Short, real guidance on how bindit fits together. Every link opens a page that exists. */
export function More() {
  return (
    <div className="ui-page placeholder more">
      <header className="ui-page-header">
        <div>
          <span className="ui-eyebrow">Help</span>
          <h1 className="ui-page-title">How bindit works</h1>
          <p className="ui-page-subtitle">bindit keeps your schoolwork in one binder: notes sorted by course and unit, practice made from those notes, and the people you study with.</p>
        </div>
      </header>

      <section className="ui-section" aria-labelledby="help-notes">
        <div className="ui-section-head"><h2 className="ui-section-title" id="help-notes">Study from your own notes</h2></div>
        <ol className="ui-panel placeholder__steps">
          <li><span><b>Add a course and its units.</b> In <a href="#tools">Study</a>, create a course, then a unit for each topic or chapter.</span></li>
          <li><span><b>Add notes to a unit.</b> Upload a photo, PDF, or document, or paste typed notes straight into the unit.</span></li>
          <li><span><b>Practice.</b> Switch the unit to Flashcards or Quiz in <a href="#tools">Study</a>. Both are built from the notes in that unit.</span></li>
          <li><span><b>Ask the tutor.</b> In <a href="#tutor">Tutor</a>, pick a course and unit so answers use your notes first. You can attach a photo of a problem.</span></li>
        </ol>
      </section>

      <section className="ui-section" aria-labelledby="help-plan">
        <div className="ui-section-head"><h2 className="ui-section-title" id="help-plan">Plan and study together</h2></div>
        <ol className="ui-panel placeholder__steps">
          <li><span><b>Track tasks.</b> <a href="#goals">Tasks</a> holds what is due, with a board and a list view.</span></li>
          <li><span><b>Join a study group.</b> In <a href="#profile">Friends &amp; groups</a>, create a group or join one with its invite code.</span></li>
          <li><span><b>Message your group.</b> Each group has a private chat in <a href="#chat">Messages</a>. Only its members can read the messages and images.</span></li>
          <li><span><b>Make it yours.</b> Change your name, daily goal, theme, and privacy in <a href="#settings">Settings</a>.</span></li>
        </ol>
      </section>

      <section className="ui-section" aria-labelledby="help-privacy">
        <div className="ui-section-head"><h2 className="ui-section-title" id="help-privacy">Privacy and your data</h2></div>
        <div className="ui-panel ui-panel--padded">
          <p className="more__privacy">Your notes, photos, quiz answers and tutor messages are sent to AI providers to make your study materials, so please don’t upload sensitive personal information. Read the <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Service</a>, or email <a href="mailto:officialbindet@gmail.com">officialbindet@gmail.com</a> to get a copy of your data or delete your account.</p>
        </div>
      </section>

      <section className="ui-section" aria-labelledby="help-planned">
        <div className="ui-section-head"><h2 className="ui-section-title" id="help-planned">Coming to this page</h2></div>
        <ComingSoonCards
          label="Planned help pages"
          items={[
            { title: 'Guides', copy: 'Step-by-step walkthroughs for notes, flashcards, quizzes, and the tutor.', icon: Icons.help, tone: 'blue' },
            { title: 'Feedback', copy: 'A way to tell us what to fix or build next, right from the app.', icon: Icons.message, tone: 'violet' },
          ]}
        />
      </section>
    </div>
  )
}
