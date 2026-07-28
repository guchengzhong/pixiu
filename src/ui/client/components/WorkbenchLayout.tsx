import type { CSSProperties, ReactNode } from "react"

export const WORKBENCH_NAVIGATION_ID = "pixiu-navigation"
export const WORKBENCH_NAVIGATION_TRIGGER_ID = "pixiu-navigation-trigger"
export const WORKBENCH_INSPECTOR_ID = "pixiu-inspector"
export const WORKBENCH_INSPECTOR_TRIGGER_ID = "pixiu-inspector-trigger"

export function WorkbenchLayout({
  sidebar,
  topBar,
  children,
  configModal,
  permissionModal,
  sidebarCollapsed,
  inspectorCollapsed,
  mobileNavOpen,
  inspectorWidth,
  onCloseMobileNav,
}: {
  sidebar: ReactNode
  topBar: ReactNode
  children: ReactNode
  configModal: ReactNode
  permissionModal: ReactNode
  sidebarCollapsed: boolean
  inspectorCollapsed: boolean
  mobileNavOpen: boolean
  inspectorWidth: number
  onCloseMobileNav(): void
}) {
  const style = { "--inspector-width": `${inspectorWidth}px` } as CSSProperties
  return (
    <div
      className={`app workbench-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${inspectorCollapsed ? "inspector-collapsed" : ""} ${mobileNavOpen ? "mobile-nav-open" : ""}`}
      style={style}
    >
      {sidebar}
      <button
        className="mobile-nav-backdrop"
        type="button"
        aria-controls={WORKBENCH_NAVIGATION_ID}
        aria-hidden="true"
        tabIndex={-1}
        onClick={onCloseMobileNav}
      />
      <main className="main workbench-main">
        {topBar}
        <section className="content">{children}</section>
      </main>
      {configModal}
      {permissionModal}
    </div>
  )
}
