---
task_id: "014-good-sanitized-html"
label: good
ground_truth: APPROVE
bug: ""
rubric_criterion: "R-XSS: HTML from a user is rendered only after sanitisation with an allow-list."
---

## Author rationale
Release notes are written in Markdown by staff. I render them to HTML and pass the result
through DOMPurify with an allow-list before it reaches the page.

## Diff
```diff
--- a/src/components/ReleaseNotes.tsx
+++ b/src/components/ReleaseNotes.tsx
@@ -1,8 +1,13 @@
+import DOMPurify from 'dompurify'
+import { marked } from 'marked'
+
+const ALLOWED = { ALLOWED_TAGS: ['p', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'code'], ALLOWED_ATTR: ['href'] }
+
 export function ReleaseNotes({ markdown }: { markdown: string }) {
-  return <pre className="notes">{markdown}</pre>
+  const html = DOMPurify.sanitize(marked.parse(markdown, { async: false }), ALLOWED)
+  return <div className="notes" dangerouslySetInnerHTML={{ __html: html }} />
 }
```
