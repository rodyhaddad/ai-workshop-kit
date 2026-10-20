# AI Workshop kit

The files you need during the AI Workshop. Everything in here is invented demo data or a small tool. Nothing in it is about you or anyone in the room.

## Get it

Open Claude Code in your workshop folder and say:

```
Clone https://github.com/rodyhaddad/ai-workshop-kit into this folder.
```

Or type it yourself, in the terminal (Mac, or Git Bash on Windows):

```
git clone https://github.com/rodyhaddad/ai-workshop-kit.git
```

No git? Press the green **Code** button on this page, then **Download ZIP**, and unzip it in your workshop folder.

## Get the latest

Files get added during the week. To pull them in, tell Claude "Get the latest ai-workshop-kit", or run:

```
cd ai-workshop-kit
git pull
```

## What's inside

| File | What it is |
|---|---|
| `transcripts.mjs` | The transcript viewer. It shows your own Claude Code sessions in your browser. |
| `demo-inbox/` | 15 invented emails for a made-up coffee roastery in Tbilisi. Use them when you need an inbox that isn't yours. |

The prompt-injection exercise has its own branch, `r4-prompt-injection`. See the end of this page.

## The transcript viewer

From your workshop folder:

```
node ai-workshop-kit/transcripts.mjs
```

Your browser opens at `http://127.0.0.1:4321/`. Press `Ctrl+C` in the terminal to stop it.

It only runs on your laptop. It reads your sessions from `~/.claude/projects`. It never changes anything and sends nothing anywhere.

## The demo inbox

Mtatsminda Roasters is a fictional café and coffee roastery. James Beridze, the owner, is invented too. So is every person, business, invoice and amount in these emails.

One of them, `14-suspicious-bank-email.md`, is a fake phishing email on purpose. See if Claude spots it.

## The prompt-injection sandbox

Five invented supplier documents. One of them hides instructions for Claude. It lives on its own branch so it never lands in the folder you work in all week.

Get a fresh copy for the exercise:

```
git clone -b r4-prompt-injection https://github.com/rodyhaddad/ai-workshop-kit.git sandbox-test
cd sandbox-test
```

Only use it for that exercise, and only on this copy. Want to start over? Delete `sandbox-test` and clone it again.
