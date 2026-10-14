// The mark's styles live with the sidebar's (SiteSidebar.css). This file is separate so the
// landing page and sign-in screens can show the mark without loading the whole sidebar.
import './SiteSidebar.css'

/* The bindet mark: a sheet bound by two violet rings. */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg className="bindit-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="3.5" width="13.5" height="17" rx="2" className="bindit-mark__sheet" />
      <path d="M9.5 8.5h6.5M9.5 12h6.5M9.5 15.5h4" className="bindit-mark__lines" />
      <circle cx="6" cy="8" r="1.9" className="bindit-mark__ring" />
      <circle cx="6" cy="16" r="1.9" className="bindit-mark__ring" />
    </svg>
  )
}
