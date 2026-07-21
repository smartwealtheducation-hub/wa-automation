# WA Automation Pipeline (Free Stack)

Fully automated weekly pipeline: writes an SEO blog post with a generated
header image, publishes it to WordPress, shares it to Facebook, LinkedIn,
Instagram, and Pinterest, and sends a weekly email. Runs on **GitHub
Actions** (free tier) — no server needed.

Everything here uses genuinely free tiers - see the honesty note at the
bottom for the small number of real-world limits that come with that.

Since you chose fully unattended mode, everything publishes without human
review. Keep an eye on the first few runs to catch issues early.

## 1. Get your project onto GitHub

1. Create a new **private** GitHub repository.
2. Upload everything in this folder to it (or `git init` + push).

## 2. Get your free credentials

- **Gemini API key** (text generation): aistudio.google.com/apikey — no credit card required.
- **Image generation**: nothing to set up — Pollinations.ai needs no account or key.
- **WordPress**: your site admin → Users → your profile → Application Passwords → create one. Note your site URL, username, and the generated app password.
- **Facebook**: developers.facebook.com → create an app → get a Page Access Token for your Page (needs `pages_manage_posts` permission). Use a **long-lived** token so it doesn't expire in an hour.
- **Instagram**: your account must be a Business or Creator account, linked to your Facebook Page. In Graph API Explorer: `GET /me/accounts` for your Page ID, then `GET /{page-id}?fields=instagram_business_account` for `IG_BUSINESS_ACCOUNT_ID`. Reuses the Facebook Page token — no separate token needed.
- **Pinterest**: developers.pinterest.com → create an app → create a board in the Pinterest app first (note its ID) → generate an access token. Pinterest reviews apps before granting full "Standard" API access — check your app's access level if pin creation fails.
- **LinkedIn**: developer.linkedin.com → create an app → request the "Share on LinkedIn" product → complete OAuth for an access token and your member URN. Tokens expire ~60 days; you'll need to refresh manually unless you build a refresh flow.
- **Kit** (formerly ConvertKit — replaces Hubspot for sending, see note below): app.kit.com → free signup, no card → Settings → Developer Settings → create an API key.

### About Hubspot

Your existing Hubspot account can't send automated marketing emails via API
on the Free/Starter/Pro tiers — that specific capability is restricted to
Hubspot's Enterprise plan. Kit's free plan (up to 10,000 subscribers,
unlimited broadcast sends, full API access, no card) supports it, so this
pipeline sends through Kit instead. You'll need to export your contacts from
Hubspot as a CSV and import them into Kit once. You can still keep using
Hubspot as your CRM for everything else if you'd like — this only replaces
the automated sending piece.

## 3. Add secrets to GitHub

In your repo: **Settings → Secrets and variables → Actions → New repository secret**.
Add every value from `.env.example` as a secret (same names):

```
GEMINI_API_KEY
WP_SITE_URL
WP_USERNAME
WP_APP_PASSWORD
FB_PAGE_ID
FB_PAGE_ACCESS_TOKEN
IG_BUSINESS_ACCOUNT_ID
PINTEREST_ACCESS_TOKEN
PINTEREST_BOARD_ID
LINKEDIN_ACCESS_TOKEN
LINKEDIN_MEMBER_URN
KIT_API_KEY
WA_AFFILIATE_LINK
SITE_NICHE
```

## 4. Test it manually first

Go to the **Actions** tab in your repo → "Weekly WA Automation" → **Run workflow**.
This triggers it on demand so you can check your website, Facebook Page,
Instagram, Pinterest, LinkedIn, and Brevo before trusting the weekly
schedule.

## 5. It then runs automatically

Every Monday 09:00 UTC (edit the `cron` line in
`.github/workflows/weekly-automation.yml` to change the schedule/timezone).

## Being honest about "free"

Every piece here uses a real, no-cost tier — but "free" always comes with
limits, and it's worth knowing them upfront rather than being surprised:

- **Gemini's free tier** has a daily request cap (currently generous enough
  for one run/week, but Google has cut these limits before without much
  notice — if requests start failing, check ai.google.dev for current limits).
- **Pollinations.ai** has no uptime guarantee and a soft rate limit on
  anonymous use — fine for weekly, not for rapid retries.
- **Pinterest** may cap your app to limited/trial access until they approve
  it for full "Standard" access.
- **Kit's free plan** caps at 10,000 subscribers with unlimited sends — plenty
  of headroom, but if you ever exceed that, you'd need to upgrade.
- **LinkedIn tokens expire ~60 days** and need manual renewal.

None of these cost money. They're just real constraints of using no-cost
tiers instead of paid ones — worth knowing now rather than discovering
mid-run.

## One Instagram-specific thing to know

Instagram doesn't allow clickable links in captions — that's an Instagram
platform rule, not something automation can work around. The generated
caption tells people to check the link in your bio or search the article
title, so make sure your Instagram bio link actually points to your site.

## Local testing (optional)

```bash
npm install
cp .env.example .env   # fill in your real values
node --env-file=.env agents/content-agent.js
node --env-file=.env agents/social-agent.js
node --env-file=.env agents/linkedin-agent.js
node --env-file=.env agents/instagram-agent.js
node --env-file=.env agents/pinterest-agent.js
node --env-file=.env agents/email-agent.js
```
