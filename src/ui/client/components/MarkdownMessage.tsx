import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react"
import { Check, Copy, X } from "lucide-react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import remarkGfm from "remark-gfm"

type CopyStatus = "idle" | "copied" | "error"

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  css: "CSS",
  html: "HTML",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  markdown: "Markdown",
  md: "Markdown",
  plaintext: "Plain text",
  python: "Python",
  py: "Python",
  shell: "Shell",
  sh: "Shell",
  text: "Plain text",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
}

export function isExternalMarkdownLink(href: string | undefined): boolean {
  if (!href) return false
  return /^(?:https?:)?\/\//i.test(href.trim())
}

export function codeLanguageLabel(className: string | undefined): string {
  const language = className?.match(/(?:^|\s)language-([^\s]+)/)?.[1]?.toLowerCase()
  if (!language) return "Plain text"
  return LANGUAGE_LABELS[language] ?? language.toUpperCase()
}

export function normalizeCodeForCopy(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value
}

function textFromReactNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textFromReactNode).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return textFromReactNode(node.props.children)
  return ""
}

function codeClassName(children: ReactNode): string | undefined {
  const code = Children.toArray(children).find(isValidElement)
  if (!code) return undefined
  const value = (code.props as { className?: unknown }).className
  return typeof value === "string" ? value : undefined
}

async function copyCode(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard API is unavailable")
  await navigator.clipboard.writeText(value)
}

function CodeBlock({ children, className, ...props }: React.ComponentPropsWithoutRef<"pre">) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle")
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const code = normalizeCodeForCopy(textFromReactNode(children))
  const language = codeLanguageLabel(codeClassName(children))

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current)
  }, [])

  async function handleCopy() {
    try {
      await copyCode(code)
      setCopyStatus("copied")
    } catch {
      setCopyStatus("error")
    }

    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopyStatus("idle"), 2_000)
  }

  const copyLabel = copyStatus === "copied" ? "Code copied" : copyStatus === "error" ? "Copy failed" : "Copy code"

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-toolbar">
        <span className="markdown-code-language">{language}</span>
        <div className="markdown-code-actions">
          <span className={`markdown-code-feedback ${copyStatus}`} aria-live="polite">
            {copyStatus === "copied" ? "Copied" : copyStatus === "error" ? "Copy failed" : ""}
          </span>
          <button
            className={`markdown-code-copy ${copyStatus}`}
            type="button"
            onClick={() => void handleCopy()}
            aria-label={copyLabel}
            title={copyLabel}
          >
            {copyStatus === "copied" ? <Check aria-hidden="true" /> : copyStatus === "error" ? <X aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </button>
        </div>
      </div>
      <pre {...props} className={["markdown-code-pre", className].filter(Boolean).join(" ")}>
        {children}
      </pre>
    </div>
  )
}

const markdownComponents: Components = {
  a({ node: _node, href, children, ...props }) {
    const external = isExternalMarkdownLink(href)
    return (
      <a
        {...props}
        href={href}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    )
  },
  img({ node: _node, alt, src }) {
    const label = alt?.trim() || "Image"
    return <span className="markdown-image-placeholder">{src ? `${label} (${src})` : label}</span>
  },
  pre({ node: _node, children, ...props }) {
    return <CodeBlock {...props}>{children}</CodeBlock>
  },
}

export function MarkdownMessage({ content, className }: { content: string; className?: string }) {
  return (
    <div className={["markdown-message", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={markdownComponents}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
