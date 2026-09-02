# Parity notes — capture protocol (Agent F)

One note per surface, named `NN-<surface>.md`, ordered as in the Agent F brief §5.

## How the numbers in these notes are produced

Every value is read off the **live DOM** via Playwright `getComputedStyle`, never
estimated from a screenshot. Screenshots prove the result; the numbers drive the
fix. The probe pattern:

```js
getComputedStyle(document.querySelector('nav a[href*="/contacts"]'))
```

Compare against DealFlow's token, then **change the token, not the component**
(brief §7).

### Two traps that produce false findings

1. **`transition-colors` lies to `getComputedStyle`.** Reading a colour
   immediately after flipping `data-theme` returns the *in-flight* value, not the
   target. It looks exactly like a broken theme token. Always settle ~400ms
   before sampling, or you will "find" a dark-mode bug that does not exist.
2. **The Next.js dev-tools portal (`<nextjs-portal>`) overlays the bottom-left**
   of every dev screenshot as a dark circular "N". It is not a layout fault and
   does not exist in a production build. Hide it before capturing:
   ```js
   document.head.insertAdjacentHTML('beforeend',
     '<style>nextjs-portal{display:none!important}</style>')
   ```

## Redacting Close captures — REQUIRED

`reference/close/` is committed, and Ryan's Close workspace holds **real client
PII**: contact names, email addresses, phone numbers and home addresses. An
earlier unredacted capture is the reason `.gitignore` carries the `**/* 2.png`
guard.

Redact **at capture time** by blurring in the page, then screenshotting — do not
edit the PNG afterwards, and never commit a raw capture "to fix later":

```js
// Blur every data-bearing cell; chrome (headers, buttons, nav) stays sharp
// so spacing, colour and type are still measurable.
document.querySelectorAll('table tbody tr').forEach(tr =>
  [...tr.children].forEach((td, i) => { if (i > 0) td.style.filter = 'blur(5px)' }))
```

For list/detail surfaces, walk up from any element whose text matches an email or
phone pattern to its full-width row container and blur that container — blurring
the leaf span alone leaves the sender name and subject readable.

**Check the capture before committing it.** Blur must cover names, addresses,
emails, phones; it must NOT cover the chrome being compared.
