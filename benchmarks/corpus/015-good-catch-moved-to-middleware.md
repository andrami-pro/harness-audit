---
task_id: "015-good-catch-moved-to-middleware"
label: good
ground_truth: APPROVE
bug: ""
rubric_criterion: "R-ERRORS: every failure reaches the caller as a structured error; none is swallowed."
---

## Author rationale
Each handler had its own try/catch that turned any error into a 500 with the same body. The
app already has an error middleware that does this and also logs the request id, so the
per-handler block only hid the stack from the logs. I removed it here; the test below covers it.

## Diff
```diff
--- a/src/api/profile.ts
+++ b/src/api/profile.ts
@@ -4,12 +4,8 @@ import { requireSession } from '../auth'
 export async function updateProfile(req: Request, res: Response) {
-  try {
-    const user = await requireSession(req)
-    const data = profileSchema.parse(req.body)
-    res.json(await db.user.update({ where: { id: user.id }, data }))
-  } catch (e) {
-    res.status(500).json({ error: 'internal' })
-  }
+  const user = await requireSession(req)
+  const data = profileSchema.parse(req.body)
+  res.json(await db.user.update({ where: { id: user.id }, data }))
 }
--- a/src/app.ts
+++ b/src/app.ts
@@ -19,4 +19,4 @@ const app = express() // express 5: a rejected async handler is passed to the error middleware
 app.use('/api', router)
 // registered last: turns any thrown error into { error, requestId } and logs the stack
 app.use(errorMiddleware)
--- a/src/api/profile.test.ts
+++ b/src/api/profile.test.ts
@@ -30,0 +31,6 @@
+  it('answers a structured 500 with a request id when the database fails', async () => {
+    db.user.update.mockRejectedValueOnce(new Error('connection lost'))
+    const res = await request(app).put('/api/profile').set(auth).send(valid)
+    expect(res.status).toBe(500)
+    expect(res.body).toEqual({ error: 'internal', requestId: expect.any(String) })
+  })
```
