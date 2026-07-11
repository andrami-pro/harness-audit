---
task_id: "006-bad-xss-dangerous-html"
label: bad
ground_truth: REJECT
bug: "Renders user-controlled `comment.body` via dangerouslySetInnerHTML with no sanitization — stored XSS."
rubric_criterion: "R-XSS: never pass unsanitized user input to dangerouslySetInnerHTML."
---

## Author rationale
Comments support basic formatting (bold, links), so we need to render HTML rather than plain text.
The body is written by our own logged-in users, and React escapes everything else on the page, so
this is safe for our use case.

## Diff
```diff
--- a/src/components/Comment.tsx
+++ b/src/components/Comment.tsx
@@ -3,7 +3,7 @@ export function Comment({ comment }: { comment: CommentModel }) {
   return (
     <li className="comment">
       <span className="author">{comment.author}</span>
-      <p className="body">{comment.body}</p>
+      <p className="body" dangerouslySetInnerHTML={{ __html: comment.body }} />
     </li>
   );
 }
```
