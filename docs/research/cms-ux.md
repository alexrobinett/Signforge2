# CMS UX: what makes ops dashboards and visual editors feel good, and what that means for SignForge

Researched 2026-11-17. Status: research, not a decision. It feeds `docs/proposals/cms-ui.md` (shadcn, neutral white app, Geist, blue #1F3FBF accent) and the editor in `docs/proposals/brand-and-editor.md`.

Claims are tagged **[verified]** (checked this session against the source linked beside the claim), **[vendor]** (from a vendor's own page: it describes their product, it does not show the product is good), **[unverified]** (could not be confirmed against a primary source this session), or **[judgement]** (my own reading, with no source behind it). Every link is listed again at the end.

## Summary

- "Fast and calm" comes down to a few measured thresholds: under 0.1 s feels like acting on the object itself, under 1 s keeps the user's train of thought, and past 10 s people leave ([NN/g](https://www.nngroup.com/articles/response-times-3-important-limits/)). Optimistic updates, a live preview and undo are all ways to keep work under the first two limits.
- In an ops tool, calm means a status is a fact the user can act on, not an alarm. Our player plays offline from cache, so for us "offline" usually means "unreachable, still playing". The competitors mostly show it as a grey badge and an email.
- The competitors' editors are generic Canva-style canvases beside a separate preview ([vendor] pages below). Our edge is that the preview *is* the player. The design should keep showing that.
- AI-generated design is recognisable by its defaults: Inter, purple gradients on white, predictable layouts ([Anthropic](https://claude.com/blog/improving-frontend-design-through-skills)). Geist with shadcn's stock look is the 2025–26 version of the same default **[judgement]**. What makes us original has to come from components only SignForge has: the player stage, the fleet's states, the time dimension.

---

## 1. Findings by topic

### 1.1 Speed and feedback thresholds

- **Three response-time limits.** 0.1 s is "about the limit for having the user feel that the system is reacting instantaneously"; 1.0 s keeps the flow of thought, although between 0.1 and 1 s the user "does lose the feeling of operating directly on the data"; 10 s is the limit for holding attention, and past it the system should say when it expects to finish. [verified] [NN/g, Response Times](https://www.nngroup.com/articles/response-times-3-important-limits/)
- **Doherty threshold.** Productivity rises when the system and the user interact at under 400 ms. This comes from Doherty and Thadani's 1982 IBM Systems Journal paper, which replaced the earlier 2-second standard. [verified] [Laws of UX](https://lawsofux.com/doherty-threshold/)
- **Loading indicators by wait length.** Under 1 s, no indicator. 2–10 s, a spinner (for one module) or a skeleton (for full-page loads only). Over 10 s, a progress bar with a time estimate. Avoid skeletons that show only a frame. [verified] [NN/g, Skeleton Screens](https://www.nngroup.com/articles/skeleton-screens/)
- **Avoid spinner flicker.** Add a short delay before showing a loading state and a minimum time it stays up. Skeletons should match the final layout so nothing shifts. [verified] [Vercel Web Interface Guidelines](https://vercel.com/design/guidelines)
- **Visibility of system status.** "Systems should always keep users informed about what is going on"; "no action with consequences to users should be taken without informing them." [verified] [NN/g, Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/)

### 1.2 Optimistic UI and local-first

- **Vercel's rule.** Update the UI at once when success is likely, reconcile with the server, and roll back or offer Undo on failure. [verified] [Vercel guidelines](https://vercel.com/design/guidelines)
- **Figma's multiplayer** applies property changes on the client "immediately instead of waiting for acknowledgement from the server", drops incoming server changes that conflict with unacknowledged local edits (so values don't flicker), and resolves conflicts per property, with the last value the server receives winning. On undo, its rule is that undoing and then redoing back to the present should leave the document unchanged. [verified] [Figma blog, How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- **Linear's speed** is widely put down to a local copy of workspace data (IndexedDB) plus a sync engine that applies writes locally and reverts them on rejection. Linear's own talk page confirms that a sync engine exists ([Linear, Scaling the sync engine](https://linear.app/blog/scaling-the-linear-sync-engine)). The mechanism details come from third-party analysis, one of whose authors says they never saw Linear's code. [unverified] [performance.dev](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown)
- **Saving patterns (GitHub Primer).** Use explicit save for declarative controls (text inputs, checkbox groups, native selects) and autosave for imperative controls (toggles, segmented controls). Don't mix the two patterns in one form. When a save fails, keep what the user entered. Primer avoids toasts on github.com because of unresolved accessibility problems. [verified] [Primer, Saving](https://primer.style/product/ui-patterns/saving/)

### 1.3 Undo instead of confirm

- **Confirmation dialogs wear out.** "If you cry wolf too many times, people will stop paying attention"; don't confirm routine actions; keep confirmations for serious, irreversible ones; and "go to great lengths to provide undo." [verified] [NN/g, Confirmation Dialogs](https://www.nngroup.com/articles/confirmation-dialog/)
- **Vercel:** "Confirm destructive actions", by asking first or offering Undo "within a safe time window." [verified] [Vercel guidelines](https://vercel.com/design/guidelines)
- **Vercel Instant Rollback** points production back at an earlier deployment without a rebuild. Traffic moves in about a second, according to Vercel's Academy. [vendor] [Instant Rollback](https://vercel.com/docs/instant-rollback), [Vercel Academy](https://vercel.com/academy/vercel-foundations/deployments)

### 1.4 Keyboard and command menus

- **Accelerators are optional.** They should be "additional, alternate ways to accomplish a task". Show shortcuts beside the actions they run, styled so novices can skip them; reveal them gradually; focus on frequent tasks; and let users undo actions triggered by accident. [verified] [NN/g, UI Accelerators](https://www.nngroup.com/articles/ui-accelerators/)
- **Labels and shortcuts.** Labels of 2–4 words, specific verbs, a noun where the target is unclear ("Delete Folder"), the same label everywhere, no reassigned standard shortcuts. [verified] [NN/g, UI Copy](https://www.nngroup.com/articles/ui-copy/)
- **Raycast's Action Panel.** ⌘K on any item lists that item's actions. Enter runs the first action, and the list filters "in real-time using fuzzy matching." [verified] [Raycast Manual, Action Panel](https://manual.raycast.com/action-panel)
- **Superhuman's palette rules.** One shortcut everywhere, show each command's shortcut so users learn it, fuzzy matching, and aliases in the user's own words. [verified] [Superhuman blog](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)
- **Vercel:** "Keyboard works everywhere", following WAI-ARIA patterns. Shortcuts should be locale-aware and show the platform's symbols. Keep state in the URL so links, refresh and Back work. [verified] [Vercel guidelines](https://vercel.com/design/guidelines)

### 1.5 Direct manipulation, live preview, inline editing

- **Direct manipulation** means acting "on displayed objects of interest" with actions that are "physical, incremental, and reversible": visible objects, immediate results, and recognition rather than recall. [verified] [NN/g, Direct Manipulation](https://www.nngroup.com/articles/direct-manipulation/)
- **Webflow** separates editing from preview. Preview shows the published look, keeps breakpoint switching, and allows no selection. Styles cascade from the desktop breakpoint down. [vendor] [Webflow, canvas overview](https://help.webflow.com/hc/en-us/articles/33961319255059-Webflow-canvas-overview), [Breakpoints overview](https://help.webflow.com/hc/en-us/articles/33961300305811-Breakpoints-overview)
- **Framer** previews at a selected breakpoint's width, and its Academy advises dragging the viewport continuously between sizes to catch layout breaks. [vendor] [Framer Help, Previewing](https://www.framer.com/help/articles/how-to-preview-your-site/), [Framer Academy, fluid layouts](https://www.framer.com/academy/lessons/framer-fundamentals-designing-fluid-layouts)
- **Notion's** block editing is the reference for inline editing: hover a block for the ⋮⋮ handle, drag it with blue drop guides, click the handle for "Turn into", or type `/` to insert. [vendor] [Notion, Writing and editing basics](https://www.notion.com/help/writing-and-editing-basics)
- **Canva's Brand Kit** shows brand colours as swatches in every colour picker, applies a brand colour theme to a whole design (with Shuffle), and replaces an off-brand colour on every page with "Apply to all pages". Brand Controls can restrict a team to the kit. [vendor] [Canva Help, Apply Brand Kit colours](https://www.canva.com/help/apply-brand-kit-colors/), [Brand Kit text styles](https://www.canva.com/help/apply-brand-kit-text-styles/)

### 1.6 Information density and typography for ops tools

- **Linear's redesign** aimed to "reduce visual noise, maintain visual alignment, and increase the hierarchy and density of navigation elements". It moved themes from HSL to LCH, cut theme inputs from 98 variables to three (base, accent, contrast), limited how much the blue brand colour fed into the chrome so the result was "more neutral and timeless", and used Inter Display for headings. [verified] [Linear, How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui)
- **Stripe's colour system** uses a perceptually uniform model (CIELAB), because in HSL "yellow appears lighter than blue" at the same lightness. Any two colours five levels apart pass for small text, and four levels apart pass for icons and large text. "Accessible doesn't mean vibrant." [verified] [Stripe, Designing accessible color systems](https://stripe.com/blog/accessible-color-systems)
- **Geist** is Vercel's design system, "a high contrast, accessible color system", set in Geist Sans and Geist Mono. Geist Sans "is designed for interfaces and body copy", and Geist Mono "prioritizes readability in code and tabular content". It is licensed under the SIL OFL 1.1. [verified] [Geist introduction](https://vercel.com/geist/introduction), [Geist font](https://vercel.com/font)
- **Numbers that compare** should use `font-variant-numeric: tabular-nums` or a mono font. [verified] [Vercel guidelines](https://vercel.com/design/guidelines)
- **Row heights (IBM Carbon):** 24, 32, 40, 48 and 64 px. 64 px is only for two-line rows, and header rows match the body. Our proposed 36 px sits between Carbon's sm and md. [verified] [Carbon, Data table style](https://carbondesignsystem.com/components/data-table/style/)
- **Tables:** freeze header rows (and the first column if needed); light borders, zebra striping and hover highlighting help users keep their place. [verified] [NN/g, Data Tables](https://www.nngroup.com/articles/data-tables/)
- **Dashboards** should give "at-a-glance information" with "a minimum of interaction". Use length and 2D position for quantities, and don't use colour for magnitude. Avoid pies, gauges and 3D charts. An *operational* dashboard (live, time-sensitive) is a different thing from an *analytical* one. [verified] [NN/g, Dashboards: preattentive](https://www.nngroup.com/articles/dashboards-preattentive/)

### 1.7 Motion

- **Durations.** Most UI animation runs 100–500 ms: about 100 ms for small feedback such as toggles, 200–300 ms for a modal, and 400 ms only for large moves. Exits are a little shorter than entrances. [verified] [NN/g, Animation Duration](https://www.nngroup.com/articles/animation-duration/)
- **Apple HIG.** "Add motion purposefully… Don't add motion for the sake of adding motion"; "Make motion optional", so motion is never the only signal; "Aim for brevity and precision in feedback animations." [verified] [Apple HIG, Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- **Vercel.** Honour `prefers-reduced-motion`, keep animations interruptible, never `transition: all`, animate only transform and opacity, and prefer CSS, then WAAPI, then JS libraries. [verified] [Vercel guidelines](https://vercel.com/design/guidelines)
- **Frequency.** Things used constantly, such as command menus and context menus, are often better with no animation, because the animation "feel[s] more like cognitive burden after seeing the same animation for the hundredth time." Interactions should be interruptible. [verified] [Rauno Freiberg, Invisible Details of Interaction Design](https://rauno.me/craft/interaction-design)
- **WCAG 2.3.3 (AAA):** motion triggered by interaction can be disabled unless essential, via `prefers-reduced-motion` (technique C39). [verified] [W3C Understanding 2.3.3](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)
- **Material 3 duration and easing tokens** (for example, short1 50 ms and medium2 300 ms) appear consistently in third-party copies, but the official m3.material.io page did not render for me. [unverified] [M3, Easing and duration](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs)

### 1.8 Empty states and onboarding

- **Empty states** should report system status (a blank area causes confusion, and an early "No records" message misleads), teach in context ("Star your favorites to list them here"), and give a direct path to the key task. [verified] [NN/g, Empty States](https://www.nngroup.com/articles/empty-state-interface-design/)
- **Primer's Blankslate** requires only primary text and one primary action. For a feature not used yet, the action should start a creation flow; for an error, it should lead to a fix or to help. [verified] [Primer, Empty states](https://primer.style/product/ui-patterns/empty-states/)
- **Tutorials** "interrupt users, don't necessarily improve task performance, and are quickly forgotten." Prefer *pull* revelations, triggered by what the user is doing, that can be dismissed and found again. [verified] [NN/g, Onboarding Tutorials](https://www.nngroup.com/articles/onboarding-tutorials/)
- **Degraded states.** Don't hide that something is wrong. Say that content is *unavailable* rather than showing an empty state, so users don't think data was lost. Render the page without failed secondary parts. Show about five outage messages at most. [verified] [Primer, Degraded experiences](https://primer.style/product/ui-patterns/degraded-experiences/)

### 1.9 Status and fleet monitoring

- **Colour alone is not enough** (WCAG 1.4.1, Level A). [verified] [W3C Understanding 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- **Carbon's status indicators** use at least two of colour, shape and symbol, need 3:1 contrast, put the shape *before* the label, never reuse one shape in different colours, roll a group up to its highest-attention state, and stop at about five or six indicator types. [verified] [Carbon, Status indicator pattern](https://carbondesignsystem.com/patterns/status-indicator-pattern/)
- **Status messages** (such as "5 results returned" or a progress update) must reach assistive tech without taking focus, through `role="status"` or a live region (WCAG 4.1.3, AA). [verified] [W3C Understanding 4.1.3](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
- **Staged rollouts (Vercel Rolling Releases).** Stages at rising traffic fractions, the last always 100%. The release is "prominently indicated" on the Deployments page, with the candidate badged "Canary" and its traffic share shown. Users can advance a stage, abort, or roll back, and only one rolling release runs at a time. [vendor] [Vercel, Rolling Releases](https://vercel.com/docs/rolling-releases)

---

## 2. What competitors do

| | Status model | Offline handling | Alerts | Editor |
| --- | --- | --- | --- | --- |
| **ScreenCloud** | Screens Manager filters by online, offline, deactivated, suspended [vendor] ([help](https://help.screencloud.com/en/articles/10119927-screens-manager-managing-your-screens-across-your-whole-organization)) | A grey "Offline" badge means "either your screens are showing cached content in offline mode" or not connected. It caches local media only [vendor] ([help](https://help.screencloud.com/s/article/Screen-Showing-Offline-How-to-Troubleshoot-Connectivity-Issues)) | Email on offline and back online, with a per-screen threshold [vendor] ([update](https://screencloud.com/product-updates/digital-signage/screen-notifications-feature)) | Canvas: templates, portrait/landscape presets, brand fonts and colours, locked elements so editors swap only text and images [vendor] ([Canvas](https://screencloud.com/apps/canvas), [help](https://help.screencloud.com/en/articles/10120182-screencloud-studio-canvas)) |
| **Yodeck** | Screen messages with explicit states: Registering, Registered, Online, Offline, Off ("Screen turned off"), and a live screenshot when it is working [verified] ([help](https://help.yodeck.com/en/articles/757879-understanding-yodeck-screen-messages)) | n/a in sources | Per-screen email settings, sent only to Device Managers [vendor] ([docs](https://www.yodeck.com/docs/user-manual/screen-email-notifications/)) | Multi-zone layout editor, layers, stock photos, an AI copy tool; locked branded templates (Enterprise) with draft and published states [vendor] ([docs](https://www.yodeck.com/docs/user-manual/branded-templates-layout-editor/)) |
| **OptiSigns** | Reports every 30 s, marked offline after 10 min of silence [verified] ([support](https://support.optisigns.com/hc/en-us/articles/360016484473-Why-Does-My-Screen-Show-as-Offline-on-the-Web-Portal)) | Keeps playing cached content. An optional on-screen offline indicator appears after about 1 min [vendor] ([support](https://support.optisigns.com/hc/en-us/articles/12947820509971-Show-Hide-Offline-Indicator-on-your-Player)) | Monitoring Alert, with hourly or daily reminders; plan-gated per a translated page [vendor] ([support](https://support.optisigns.com/hc/en-us/articles/4403306341523-How-to-set-up-Monitoring-Alert-feature)) | Designer in the portal: drag and drop, widgets, layers panel, landscape/portrait resize, data mapping [vendor] ([Designer](https://www.optisigns.com/product/content-library/designer), [2.0 post](https://www.optisigns.com/post/optisigns-designer-2-0-whats-new-improved)) |
| **Rise Vision** | Online, Offline, Standby; Standby counts as online [unverified: help pages refused direct fetch, read from search excerpts] ([help](https://help.risevision.com/hc/en-us/articles/16176509165972-Enable-Display-Monitoring)) | n/a in sources | Email after 15 min offline and after 15 min back online; a daily or weekly status report with uptime and a CSV [unverified, same reason] ([report](https://help.risevision.com/hc/en-us/articles/51675702135444-Set-Up-the-Display-Status-Report-Email)) | Presentation editor: a component list beside a preview, drag handles in the preview, autosave with an "Unsaved changes" notice, Publish then choose schedules [unverified, same reason] ([help](https://help.risevision.com/hc/en-us/articles/20335255843988-How-to-Customize-a-Presentation)) |

**What they do well**

- Yodeck's message table is the most honest status model: each state says what is happening and whether to act ("Waiting for screen to come online", "Screen turned off: only if unexpected"). [verified]
- Several of them separate *asleep* from *broken*: Rise Vision counts Standby as online, and Yodeck has a separate Off state. [verified / unverified as tagged]
- Alert thresholds that ignore short drops (ScreenCloud per screen, OptiSigns' 10 min, Rise Vision's 15 min) treat flapping as noise. [vendor]
- Locked brand templates (ScreenCloud, Yodeck) answer the real small-business problem: staff change the price, not the font. [vendor]

**Where they feel dated** [judgement, from their own help pages and screenshots]

- Offline is a grey badge plus an email. None of the pages I read tells the user *what the screen is still playing* while offline, even though the players play from cache.
- Rollout is invisible. Publishing is "Publish → choose schedules", with no per-screen view of which screens have the new content and which are waiting.
- Editors copy Canva (layers, stickers, stock photos), and the preview is a separate render of the design, not the player. Rise Vision's "Unsaved changes" banner beside autosave shows two save patterns mixed, which Primer advises against.
- Email is the only alert channel ScreenCloud states. [vendor]
- AI features are bolted on as a copy-writing button inside the editor (Yodeck's Magic Write, Rise Vision's "Create a Presentation with AI"), not an agent working in the product's own terms. [vendor] ([Rise AI help](https://help.risevision.com/hc/en-us/articles/47532571934996-Create-a-Presentation-with-AI-in-Rise-Vision))

**Arc** was in the brief, but I found no primary source this session on its interaction design to cite. [unverified]

---

## 3. Patterns that read as AI-generated, to avoid

Sourced: without guidance, AI output converges on "Inter fonts, purple gradients on white backgrounds, and minimal animations", because "safe design choices… dominate web training data". This "makes AI-generated interfaces immediately recognizable—and dismissible." Anthropic's frontend skill lists clichéd colour schemes, overused fonts (Inter, Roboto, Arial, system fonts) and "predictable layouts and component patterns". [verified] [Anthropic, Improving frontend design through Skills](https://claude.com/blog/improving-frontend-design-through-skills)

Beyond that source, these are my own list of tells **[judgement]**:

- **Unmodified shadcn plus Geist.** Zinc greys, the default radius, Geist. In 2026 that is the starter-template look, the way Bootstrap blue once was. Geist is fine; the default look around it is the problem.
- **Gradient blob heroes, glass cards, neon glow in dark mode.** The landing page is navy and product-led: show the real player stage and a real screens table, not abstract shapes.
- **Cards inside cards.** Every section in a rounded, shadowed card. In an ops tool, tables and plain dividers carry more data with less noise (Linear's "reduce visual noise").
- **KPI tiles with % deltas and decorative sparklines** ("Screens online 98% ↑2.1%") that answer no question. NN/g: an operational dashboard answers a time-sensitive question at a glance.
- **Sparkle ✨ "AI" buttons and a chat pane bolted on the side.** Our agents act through the same tools as people (MCP and WebMCP over the tool registry). Show their work as authored changes, not as a magic button.
- **Copy:** "Supercharge", "Unlock", "Seamless", "Effortlessly", plus emoji as icons. Use the product's nouns instead: screen, spot, playlist, publish.
- **Everything centred, everything 3-column.** Feature grids of three icon cards. Ops screens are left-aligned and scannable.
- **Motion everywhere.** Fade-and-rise on every element on scroll. Motion should mean something (Apple HIG) and be absent on frequent actions (Rauno).
- **Fake data that is too clean.** Demo fleets where every screen is green. Real fleets have one asleep, one offline and one updating, and the demo org should look like that.

---

## 4. Design ideas for SignForge

Each idea names the evidence it rests on and what in our system makes it possible. Anything needing a contract or player change is marked; per AGENTS.md the contract changes first, in its own commit.

### 1. The stage is the product: preview inside 100 ms, labelled as a draft

The editor's centre is `PlayerStage`: the real player at true 1920×1080 or 1080×1920, scaled to fit, beside the field form. A keystroke reaches the frame through the preview channel (`reset`, `init`, `play`), and the target is under 100 ms from keypress to pixels, NN/g's limit for "operating directly on the data". The stage is framed as a screen (a thin bezel with the screen's aspect), with one quiet label above it: "Draft. Not on any screen." Nothing else animates. While a field is invalid, the stage keeps the last valid frame, and the field shows the contract's problem message, so the preview never goes blank under the user's typing.
*Evidence:* §1.1 response limits, §1.5 direct manipulation. *Ours:* the preview is the player build (architecture, Preview mode), which no competitor's editor is.

### 2. "Should be showing now": every screen row has a live thumbnail with no camera

Competitors use screenshots, and Yodeck needs a browser extension for them. We can do better without one: the CMS knows each screen's manifest, its schedule, display hours and time zone, and the player evaluates them deterministically. A small `PlayerStage` per row (or a cached frame) renders what that screen *should* be showing at this minute, labelled "should be showing". Where the heartbeat disagrees (a `fallbackFrom`, missing files), the row says so in words.
*Evidence:* §2 (Yodeck's screenshot states, and the extension requirement). *Ours:* the immutable manifest and schedule evaluated on the device (architecture, Manifest and Player). *Cost:* many live frames on one page is heavy, so render a frame once per spot change and cache it [judgement]. A real screenshot from the supervisor can come later and confirm it.

### 3. Offline is a fact, not an alarm: "Unreachable 2 h · still playing Spring menu"

Our player keeps playing the last good manifest offline, so the status answers *is it playing?* before *is it connected?*. A screen row reads "Offline · last seen 2 h ago · playing Spring menu (v14, cached)". If that is the latest version, the row is calm grey with no red. It only escalates when there is something to do: the screen is behind on a publish, its heartbeat reported a fallback, or it has been silent past the org's threshold. Alerts default to a threshold, as ScreenCloud, OptiSigns and Rise Vision all do, so a flapping café Wi-Fi doesn't page the owner.
*Evidence:* §2 (competitors show a grey badge with no content), §1.8 Primer (say *unavailable*, don't imply loss), §1.9 Carbon (only high attention needs immediate action). *Ours:* last known good and the offline cache (architecture, Player).

### 4. Asleep has its own word, shape and next-wake time

"Asleep" is not offline: display hours put the panel to sleep on purpose. The row says "Asleep · wakes 07:00", with a half-filled glyph, never the offline glyph. Group rollups follow Carbon (the highest-attention state wins), but asleep never counts as a problem. The four states each get a distinct *shape* placed before the word, not one dot in four colours: online (filled circle), updating (circle with an arc), asleep (half circle), offline (hollow circle). Colour comes from the status tokens in `cms-ui.md`.
*Evidence:* §1.9 Carbon (never one shape in different colours; shape before label; at most five or six types), WCAG 1.4.1, and Rise Vision counting Standby as online. *Ours:* `DisplayHours` in the contract, evaluated on the device.

### 5. A rollout is a tide line that knows why each screen is waiting

After Publish, the toast doesn't say "Done". It says "Published v15 · 3 of 8 screens playing it", and it links to a `RolloutBar` that fills as heartbeats arrive. The waiting segment is broken down by reason, because we know it: "2 asleep · update at 07:00", "1 offline · updates when back", "2 downloading". The bar ends at "8 of 8", and only then does the publish read as complete. The publish row in the history keeps the bar, so "did the Friday promo reach every store?" is a glance, not a support ticket.
*Evidence:* §1.9 Vercel Rolling Releases (the in-progress release is prominent, with its fraction shown), §1.1 (over 10 s, show progress and an estimate), §2 (competitors show no per-screen rollout). *Ours:* the per-screen Durable Object holds the target and reported manifest version (architecture, "rollout status per publish").

### 6. Undo publish, and confirm only what can't be undone

Manifests are immutable, so "undo publish" is safe and cheap: re-point the screens at the previous version, the way Vercel's Instant Rollback re-points traffic without a rebuild. The publish toast carries **Undo** for a short window, and the history row carries **Roll back to v14** for good. Removing a spot from a playlist, reordering or retiming are all optimistic, with an undo toast. Confirmation dialogs are kept for the irreversible: revoking a screen's credential and deleting an org's asset that published versions still name.
*Evidence:* §1.3 NN/g and Vercel, §1.2 Figma's undo rule. *Ours:* immutable manifests. *Contract:* a rollback is a new publish pointing at an existing version; check the publish tool supports that before promising it.

### 7. The command menu is the tool registry, the same verbs an agent uses

⌘K searches the fleet's nouns (screens by name, location or pairing code; spots; playlists) and runs actions on the selection, as Raycast's Action Panel does: "Put Lobby to sleep now", "Publish Spring menu to Downtown", "Pair a screen…". Every entry shows its shortcut (Superhuman, NN/g). The original part: the entries are generated from the same tool registry the MCP server and WebMCP expose, with the same names, scopes and roles. Anything an agent can do, a person can find in ⌘K, and the audit log uses the same verb. One vocabulary for people and agents.
*Evidence:* §1.4. *Ours:* the tool registry ("every change is a tool… a scope and a role, audited"; architecture, Agents).

### 8. Agents appear as authors, with a before/after on the stage

An agent's edit lands as a draft with an author chip ("Claude, via MCP · 2 min ago"), never as a silent change. Opening it shows the stage split: the published version left, the draft right, both live, with a field-level diff below ("Headline: 'Soup of the day' → 'Tomato basil soup'"). Accept is Publish, which needs the human's publish scope (agents draft by default). Reject is one click, with undo. This answers the "magic AI button" pattern in §3: the agent is a colleague whose work is reviewable in the product's own terms.
*Evidence:* §1.2 Figma (changes per property, and an undo that respects others' edits), §3. *Ours:* "Agents can create and edit drafts by default. Publishing to live screens is a separate scope", and "Every agent action is written to an audit log" (architecture, Agents).

### 9. Scrub time, not just the spot: "What will Lobby show on Friday at 6 pm?"

The screen detail page has a time scrubber: drag through the week and the stage shows what this screen will play at that moment: the schedule's winning playlist, the takeover that ends at its `endsAt`, and black for "Asleep (display hours)". It is the schedule editor's answer to "did I set this up right?", given as direct manipulation instead of reading rules.
*Evidence:* §1.5 direct manipulation (incremental, reversible, visible result). *Ours:* the schedule and display hours are evaluated on the device from corrected time. *Contract/player change:* the preview channel would need a clock override; `seek` was cut from editor v1 (brand-and-editor Decisions), so this is a protocol addition and comes after v1.

### 10. The empty fleet pairs a real screen in a browser tab, in under a minute

A new org's Screens page is not "No screens yet". It shows Primer's single primary action, **Open a test screen**. That opens the player in a new tab, which shows a pairing code (browser pairing works without a supervisor; architecture, Pairing). The page has the `PairingCodeInput` focused, and the user types the code they can see. The tab starts playing the demo spot with the org's brand kit. The first experience is the product working end to end, the same steps a Pi will take, not a tour. The empty state then says what a real screen needs ("A Raspberry Pi 4 and the SignForge image") as a secondary link.
*Evidence:* §1.8 NN/g empty states (status, learning cue, direct path) and tutorials (pull, not push), Primer Blankslate. *Ours:* pairing in a browser (architecture, Pairing).

### 11. The brand kit edits on the org's own spots, with contrast beside every colour

The brand kit page is not a form of hex fields. On the left are the eight `BrandKit` colours, two fonts and a logo. On the right is a grid of the org's own published spots, each a live stage, all re-theming as a colour is dragged (custom properties resolve at style time, so this is cheap). Each colour pair shows its contrast ratio and a pass or fail word, as Stripe's tool does, and a failing `on*` pair offers its derived fix in one click. "This change affects 23 spots on 8 screens" sits above Publish.
*Evidence:* §1.6 Stripe (perceptual colour, show the possible), §1.5 Canva (brand swatches everywhere; apply to all). *Ours:* `BrandKit` and the token-resolving compiler; the contrast function from M3-38.

### 12. Quiet, dense and exact: the house rules for type, density and motion

- **Density.** 36 px compact rows for screens and playlists (between Carbon sm and md), with sticky headers; comfortable spacing only in forms.
- **Type.** Geist Sans for the UI. Geist Mono only for versions, hashes, pairing codes and times, with `tabular-nums` on every column of numbers, right-aligned.
- **Time.** Relative times ("2 min ago") with the absolute time and the screen's time zone on hover. A screen in another zone shows its local time ("07:00 local").
- **Colour.** Neutral chrome, as Linear limits its brand blue, and #1F3FBF only where it means "you can act here" or "selected".
- **Motion.** Motion only where it explains a change of place: the rollout bar filling, the stage's orientation flip. 100–200 ms. None on ⌘K, menus or row hover. All of it off under `prefers-reduced-motion`.
- **Announcements.** Publish and rollout updates are announced through `role="status"`, not only shown.

*Evidence:* §1.6, §1.7, WCAG 4.1.3. *Ours:* the tokens in `cms-ui.md`. This is what keeps Geist plus shadcn from reading as the default template (§3): the components and rules, not the font, carry the identity.

---

## Sources

**Research and standards**
- NN/g, Response Times: The 3 Important Limits: https://www.nngroup.com/articles/response-times-3-important-limits/
- NN/g, Confirmation Dialogs: https://www.nngroup.com/articles/confirmation-dialog/
- NN/g, Empty States in Complex Applications: https://www.nngroup.com/articles/empty-state-interface-design/
- NN/g, Skeleton Screens 101: https://www.nngroup.com/articles/skeleton-screens/
- NN/g, Animation Duration: https://www.nngroup.com/articles/animation-duration/
- NN/g, Direct Manipulation: https://www.nngroup.com/articles/direct-manipulation/
- NN/g, Visibility of System Status: https://www.nngroup.com/articles/visibility-system-status/
- NN/g, UI Accelerators: https://www.nngroup.com/articles/ui-accelerators/
- NN/g, UI Copy: https://www.nngroup.com/articles/ui-copy/
- NN/g, Onboarding Tutorials vs. Contextual Help: https://www.nngroup.com/articles/onboarding-tutorials/
- NN/g, Data Tables: https://www.nngroup.com/articles/data-tables/
- NN/g, Dashboards: Making Charts and Graphs Easier to Understand: https://www.nngroup.com/articles/dashboards-preattentive/
- Laws of UX, Doherty Threshold: https://lawsofux.com/doherty-threshold/
- W3C, Understanding SC 1.4.1 Use of Color: https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- W3C, Understanding SC 2.3.3 Animation from Interactions: https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
- W3C, Understanding SC 4.1.3 Status Messages: https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html
- Apple HIG, Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- Material 3, Easing and duration (did not render; unverified): https://m3.material.io/styles/motion/easing-and-duration/tokens-specs

**Design systems and design-team posts**
- Vercel Web Interface Guidelines: https://vercel.com/design/guidelines
- Vercel Geist, Introduction: https://vercel.com/geist/introduction
- Vercel, Geist font: https://vercel.com/font
- Linear, How we redesigned the Linear UI: https://linear.app/now/how-we-redesigned-the-linear-ui
- Linear, Scaling the Linear sync engine: https://linear.app/blog/scaling-the-linear-sync-engine
- performance.dev, How is Linear so fast (secondary, unverified): https://performance.dev/how-is-linear-so-fast-a-technical-breakdown
- Stripe, Designing accessible color systems: https://stripe.com/blog/accessible-color-systems
- Figma, How Figma's multiplayer technology works: https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- GitHub Primer, Empty states: https://primer.style/product/ui-patterns/empty-states/
- GitHub Primer, Saving: https://primer.style/product/ui-patterns/saving/
- GitHub Primer, Degraded experiences: https://primer.style/product/ui-patterns/degraded-experiences/
- IBM Carbon, Status indicator pattern: https://carbondesignsystem.com/patterns/status-indicator-pattern/
- IBM Carbon, Data table style: https://carbondesignsystem.com/components/data-table/style/
- Raycast Manual, Action Panel: https://manual.raycast.com/action-panel
- Superhuman, How to build a remarkable command palette: https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/
- Rauno Freiberg, Invisible Details of Interaction Design: https://rauno.me/craft/interaction-design
- Anthropic, Improving frontend design through Skills: https://claude.com/blog/improving-frontend-design-through-skills

**Editors (vendor documentation)**
- Vercel, Instant Rollback: https://vercel.com/docs/instant-rollback
- Vercel Academy, Deployments: https://vercel.com/academy/vercel-foundations/deployments
- Vercel, Rolling Releases: https://vercel.com/docs/rolling-releases
- Webflow, Canvas overview: https://help.webflow.com/hc/en-us/articles/33961319255059-Webflow-canvas-overview
- Webflow, Breakpoints overview: https://help.webflow.com/hc/en-us/articles/33961300305811-Breakpoints-overview
- Framer Help, Previewing your site: https://www.framer.com/help/articles/how-to-preview-your-site/
- Framer Academy, Designing fluid layouts: https://www.framer.com/academy/lessons/framer-fundamentals-designing-fluid-layouts
- Notion, Writing and editing basics: https://www.notion.com/help/writing-and-editing-basics
- Canva Help, Apply Brand Kit colors: https://www.canva.com/help/apply-brand-kit-colors/
- Canva Help, Apply Brand Kit text styles: https://www.canva.com/help/apply-brand-kit-text-styles/

**Signage competitors (vendor documentation)**
- ScreenCloud, Screens Manager: https://help.screencloud.com/en/articles/10119927-screens-manager-managing-your-screens-across-your-whole-organization
- ScreenCloud, Screen showing offline: https://help.screencloud.com/s/article/Screen-Showing-Offline-How-to-Troubleshoot-Connectivity-Issues
- ScreenCloud, Screen notifications: https://screencloud.com/product-updates/digital-signage/screen-notifications-feature
- ScreenCloud, Canvas: https://screencloud.com/apps/canvas
- ScreenCloud, Studio Canvas help: https://help.screencloud.com/en/articles/10120182-screencloud-studio-canvas
- Yodeck, Understanding screen messages: https://help.yodeck.com/en/articles/757879-understanding-yodeck-screen-messages
- Yodeck, Screen email notifications: https://www.yodeck.com/docs/user-manual/screen-email-notifications/
- Yodeck, Branded templates: https://www.yodeck.com/docs/user-manual/branded-templates-layout-editor/
- OptiSigns, Why does my screen show as offline: https://support.optisigns.com/hc/en-us/articles/360016484473-Why-Does-My-Screen-Show-as-Offline-on-the-Web-Portal
- OptiSigns, Offline indicator on the player: https://support.optisigns.com/hc/en-us/articles/12947820509971-Show-Hide-Offline-Indicator-on-your-Player
- OptiSigns, Monitoring Alert: https://support.optisigns.com/hc/en-us/articles/4403306341523-How-to-set-up-Monitoring-Alert-feature
- OptiSigns, Designer: https://www.optisigns.com/product/content-library/designer
- OptiSigns, Designer 2.0: https://www.optisigns.com/post/optisigns-designer-2-0-whats-new-improved
- Rise Vision, Enable Display Monitoring (fetch refused; read via search excerpt): https://help.risevision.com/hc/en-us/articles/16176509165972-Enable-Display-Monitoring
- Rise Vision, Display Status Report email (same): https://help.risevision.com/hc/en-us/articles/51675702135444-Set-Up-the-Display-Status-Report-Email
- Rise Vision, How to customize a presentation (same): https://help.risevision.com/hc/en-us/articles/20335255843988-How-to-Customize-a-Presentation
- Rise Vision, Create a presentation with AI (same): https://help.risevision.com/hc/en-us/articles/47532571934996-Create-a-Presentation-with-AI-in-Rise-Vision
