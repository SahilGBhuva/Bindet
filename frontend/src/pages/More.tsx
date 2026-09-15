import { ComingSoonCards, Icons } from '../components/ComingSoonCards'

export function More() {
  return (
    <div className="ui-page more">
      <header className="ui-page-header">
        <div>
          <h1 className="ui-page-title">More</h1>
          <p className="ui-page-subtitle">Extra tools and pages that do not need their own spot in the sidebar.</p>
        </div>
      </header>
      <ComingSoonCards
        label="More pages"
        items={[
          { title: 'Help', copy: 'Guides for notes, flashcards, and quizzes.', icon: Icons.help },
          { title: 'About', copy: 'What bindit is and how it works.', icon: Icons.info },
          { title: 'Feedback', copy: 'Tell us what to fix or build next.', icon: Icons.message },
        ]}
      />
    </div>
  )
}
