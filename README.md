# Study Hub

## Run
    npm install
    Copy-Item .env.example .env     # PowerShell; edit values if needed
    npm start
Set `INITIAL_OWNER_PASSWORD` in `.env` before the first run with an empty data directory.
The first account is the Owner (default username `heng`); passwords are stored as hashes.

## Host on Cloudflare (Workers + D1 + R2)

The site is a Worker (`worker.js`) serving `public/` plus the API. Accounts, file records and quizzes
live in D1; uploaded files live in R2. Nothing is lost on restart.

1. Push this repo to GitHub.
2. Cloudflare dashboard > **Workers & Pages > Create > Import a repository** > pick the repo.
   Build command: leave empty. Deploy command: `npx wrangler deploy`.
   Wrangler creates the D1 database (`study-hub-db`) and R2 bucket (`study-hub-files`) automatically.
   (R2 must be enabled once on your account: R2 > Get started.)
3. Open the Worker > **Settings > Variables and Secrets** > add secrets:
   - `INITIAL_OWNER_PASSWORD` (8+ characters, becomes the password for `heng`)
   - `API_KEY` (any long random text)
4. Open your `https://study-hub.<you>.workers.dev` address and log in as `heng` / Owner.

Notes: uploads are limited to about 100 MB per file on Cloudflare. Old `users.json` hashes are not
transferred; create accounts again in Manage users.

## Accounts and permissions
Sign in as `heng` (Owner) and use **Manage users** to create accounts, change access, or delete accounts.
Students can view materials; Teachers can upload, rename, caption, and delete materials, and they can also create quiz exercises.
Only the Owner can manage accounts. The owner role is reserved for the existing `heng` account,
which cannot be deleted in the user manager.

## Quiz exercises
Teachers can create a quiz from the main dashboard by adding a title, description, and multiple-choice questions.
Each question supports a prompt, answer choices, a correct answer, and an optional explanation.
Students can take quizzes, see their score and answer review, and retake them. Submissions are saved with the
student account, selected answers, score, and submission time. Teachers and the Owner can see the saved
submission results. Quiz exercises and submissions are stored in `data/quizzes.json` and `data/attempts.json`.

## Keep user data on Render
The Render Blueprint (`render.yaml`) sets `DATA_DIR=/var/data` and mounts a persistent disk at
that path. User accounts, file records, quiz exercises, student submissions, and uploads are saved
there and survive deploys/restarts.
Persistent disks require a paid Render plan. If you created the service without the Blueprint,
attach a persistent disk mounted at `/var/data` and add the `DATA_DIR` environment variable with
value `/var/data` in the Render service settings. Set `INITIAL_OWNER_PASSWORD` privately in
Render's Environment settings before the first deploy if the disk has no users yet. To change the
password on an existing owner account, set `LEGACY_OWNER_PASSWORD` to its current password and
`INITIAL_OWNER_PASSWORD` to the new one; the old value is matched and migrated once. Remove the
legacy-password variable afterward. Keep both values out of Git. Do not remove or replace the
disk when deploying.

## Install on a phone
Deploy the app to a public HTTPS address (or use localhost while testing). Open that address
in the phone's browser, then tap **Add to Home Screen** in Study Hub. On iPhone/iPad, use
Safari's Share button and choose **Add to Home Screen**. The app shell can open offline,
but signing in and loading materials still requires a connection.

## Folders
- public/css/style.css   all styling
- public/js/api.js       calls to the server
- public/js/app.js       screens (login, list, viewer)
- data/users.json        local persistent user accounts (excluded from Git)
- data/files.json        file records (name, caption, kind...)
- data/quizzes.json      teacher-created quiz exercises
- data/attempts.json     student answers and scores
- uploads/               the uploaded files
- server.js              login + upload + public API + webhook

## Let other drives / apps see uploads
1. Pull list (any app):
   curl -H "x-api-key: YOUR_KEY" http://localhost:3000/api/public/files
   Each item has a `url` to download the file.
2. Push (instant): set WEBHOOK_URL. On every upload/rename/delete the server POSTs
   {"event":"uploaded|updated|deleted","file":{id,name,caption,kind,size,url},"at":"..."}
   Connect it to Zapier / Make / n8n / Google Apps Script -> Google Drive, OneDrive, Dropbox "Upload file from URL".

## Put it online (website)
Render.com (easy):
1. Put this folder on GitHub (git init, git add ., git commit, push).
2. Render > New > Blueprint > choose the repo. It reads render.yaml.
3. After deploy, set PUBLIC_URL to your https://....onrender.com address and redeploy.
4. Share that address with students. Change passwords in users.json first
   (write new plain "password" fields; they are hashed on first start).
Any host with Node, or Docker (Dockerfile included, mount a volume at /data), also works.
Uploads and users are saved in DATA_DIR, so use a persistent disk or they are lost on restart.
