import { useEffect, useRef } from "react";

const SECTIONS = [
  { id: "overview", label: "1. What this application does" },
  { id: "start-run", label: "2. Starting a bug-fix run" },
  { id: "pipeline", label: "3. The pipeline, stage by stage" },
  { id: "approval", label: "4. The human approval gate" },
  { id: "review", label: "4b. The review gate" },
  { id: "security", label: "5. Security review (AWS Security Agent)" },
  { id: "report", label: "6. Reading the report" },
  { id: "usage", label: "7. Usage & cost breakdown" },
  { id: "repository", label: "8. Repository explorer & fix review" },
  { id: "context", label: "9. Context library" },
  { id: "mcp", label: "10. MCP servers" },
  { id: "logs", label: "11. Agent logs" },
  { id: "troubleshooting", label: "12. Troubleshooting & FAQ" },
  { id: "kiro-setup", label: "13. Admin: connecting Kiro CLI" },
  { id: "decision-model", label: "14. Settings: decision model endpoints" },
];

export function UserGuide({ onClose }: { onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const jump = (id: string) => {
    contentRef.current
      ?.querySelector(`#guide-${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="guide-backdrop" role="presentation" onClick={onClose}>
      <div
        className="guide-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="guide-header">
          <div>
            <span className="eyebrow">ADLC BUG-FIX PoC</span>
            <h2 id="guide-title">User guide</h2>
          </div>
          <button className="guide-close" onClick={onClose} aria-label="Close the user guide">
            ✕ Close
          </button>
        </header>
        <div className="guide-body">
          <nav className="guide-toc" aria-label="Guide contents">
            {SECTIONS.map((section) => (
              <button key={section.id} onClick={() => jump(section.id)}>
                {section.label}
              </button>
            ))}
          </nav>
          <div className="guide-content" ref={contentRef}>
            <section id="guide-overview">
              <h3>1. What this application does</h3>
              <p>
                This is a proof of concept for an agentic development lifecycle (ADLC).
                You paste a bug report; the system analyzes it, drafts a fix plan, waits
                for your approval (or auto-approves simple cases when you opt in), lets
                the Kiro CLI coding agent implement the fix inside an isolated AWS
                Bedrock AgentCore container, independently validates the result, and
                produces an auditable report with full cost and resource usage.
              </p>
              <p>
                The target is a small demo repository (<code>todo-service</code>, an
                Express + SQLite REST API) seeded with two known bugs: a TypeScript
                compile error (BUG-001) and a SQL injection (BUG-002). Every fix lands
                on its own <code>fix/&lt;run-id&gt;</code> branch — the <code>main</code> branch is never
                modified by the agent, so you can run the demo repeatedly.
              </p>
              <p>Key principles you will see everywhere in the product:</p>
              <ul>
                <li><strong>Frozen artifacts</strong> — what you approve is exactly what executes, byte for byte, on every attempt.</li>
                <li><strong>Independent verification</strong> — the agent's claims are checked by a build gate and a separate validator model.</li>
                <li><strong>Full audit trail</strong> — every stage, decision, log line, credit, and CPU-second is recorded per run.</li>
              </ul>
            </section>

            <section id="guide-start-run">
              <h3>2. Starting a bug-fix run</h3>
              <p>On the <strong>Workflow</strong> tab, the "Start a bug-fix run" form has these fields:</p>
              <dl>
                <dt>Bug text</dt>
                <dd>
                  Paste a full bug ticket, or click a preset to load one of the seeded
                  bugs. The more precise the report (file, symptom, expected behavior),
                  the better the triage and the drafted fix plan.
                </dd>
                <dt>Analysis model</dt>
                <dd>
                  The Bedrock model used for triage and drafting: Claude Haiku 5.5,
                  Sonnet 5.5 (default) or Opus 5.5. Validation uses its own fixed model so
                  it stays independent of this choice. This is also separate from the model
                  Kiro uses to write code.
                </dd>
                <dt>Triage guidance</dt>
                <dd>
                  Editable instructions that tell the triage step how to decide between
                  a Simple and a Complex fix. Adjust it if you want the system to be
                  more conservative or more aggressive about auto-classification.
                </dd>
                <dt>Include context</dt>
                <dd>
                  When checked, all READY items from your private Context library
                  (notes, PDFs, images) are supplied to the analysis model during
                  triage. See section 8.
                </dd>
                <dt>Auto-execute simple fixes</dt>
                <dd>
                  When checked, a run whose triage verdict is SIMPLE skips the human
                  gate and executes immediately — the auto-approval is recorded in the
                  audit trail. COMPLEX runs always stop and wait for you.
                </dd>
                <dt>Decision model second opinion</dt>
                <dd>
                  When checked, the <strong>Strands Decider</strong> decision model also
                  classifies the fix as SIMPLE or COMPLEX right after triage, by answering
                  five yes/no checks about the bug report. A decision model does not write
                  text: it picks one of the given answers and returns how likely each one
                  is. The result is <strong>informative only</strong>. Routing, auto-execution
                  and the gate recommendation always follow the LLM triage. The run uses the
                  endpoint picked in ⚙ Settings (CPU or GPU), and the option can be checked
                  only while that endpoint is running (InService); the line under it shows
                  which endpoint and its status. Start, stop and pick the endpoints in
                  ⚙ Settings (section 14).
                </dd>
                <dt>Implementation model</dt>
                <dd>
                  The model Kiro CLI uses to write the code. "Kiro default" lets Kiro
                  choose; the list shows the models actually available to the
                  configured Kiro account, discovered live.
                </dd>
              </dl>
            </section>

            <section id="guide-pipeline">
              <h3>3. The pipeline, stage by stage</h3>
              <ol>
                <li>
                  <strong>TRIAGE</strong> — the analysis model reads the bug (plus your
                  context items when enabled) and classifies it SIMPLE or COMPLEX with
                  reasoning, an estimated file count, and a title.
                </li>
                <li>
                  <strong>DECISION MODEL</strong> (optional) — when the run enabled the
                  second opinion, the Strands Decider endpoint reads the bug report only
                  (never the code or the LLM verdict, so the two answers are independent)
                  and answers five yes/no checks, one per condition of the default triage
                  guidance: <em>new dependency</em>, <em>data model change</em>,{" "}
                  <em>API contract change</em>, <em>new component</em>, and{" "}
                  <em>small edit in fewer than 5 files</em>. The verdict follows from the
                  checks: SIMPLE when all five pass, COMPLEX when any one fails.
                  <ul>
                    <li>
                      <strong>Each check's "% sure"</strong> is how likely the model thinks
                      its answer to that check is (50% is a coin toss, 100% is certain).
                    </li>
                    <li>
                      <strong>The verdict's "% likely"</strong> is taken from the check that
                      decided it: for SIMPLE the least sure passing check, for COMPLEX the
                      most sure failing check. That check is highlighted.
                    </li>
                    <li>
                      <strong>Certainty</strong>: HIGH at 95% or more, MEDIUM from 75% to
                      95%, LOW below 75% (a weak hint).
                    </li>
                  </ul>
                  The run page shows it in the purple "Decision model" card beside the LLM
                  verdict, marked AGREES or DISAGREES, and the execution gate repeats the
                  verdict, its likelihood and any failing checks. The card also explains how
                  the model works and can show the exact prompt it read. If the endpoint is
                  stopped, slow or failing, the card says so and the run continues
                  unchanged.
                </li>
                <li>
                  <strong>DRAFT</strong> — the analysis model produces two candidate
                  artifacts: a Simple prompt (a single precise instruction for Kiro)
                  and a Complex specification (a structured Markdown spec with
                  Requirements, Design, Tasks, and Acceptance Criteria).
                </li>
                <li>
                  <strong>GATE</strong> — the run pauses in AWAITING_APPROVAL, unless
                  auto-execute applies (section 4).
                </li>
                <li>
                  <strong>IMPLEMENT</strong> — the approved artifact is sent to the
                  AgentCore container. The agent clones the repo, writes your MCP
                  configuration if present, runs Kiro CLI headlessly, runs the build,
                  and pushes the fix branch.
                </li>
                <li>
                  <strong>VALIDATE</strong> — a build gate first, compared with the commit
                  the run started from. Before Kiro edits anything, the agent builds that
                  base commit once. The fix passes the build gate when
                  <code> npm install &amp;&amp; npm run build</code> succeeds, or when the base
                  commit already failed and the fix adds no new error (for example BUG-002
                  while BUG-001 still breaks the build). Pre-existing errors are listed on
                  the run page, never hidden. Then the validator model reviews the diff
                  against the frozen artifact, even when the build gate failed, and
                  produces pass/fail checks.
                </li>
                <li>
                  <strong>FIX LOOP</strong> — on validation failure, the findings are fed
                  back to the agent for another attempt with the same frozen artifact, up
                  to 3 attempts. The loop stops early when another attempt cannot change
                  the result: the same build errors as the previous attempt, or two
                  attempts in a row with no changes. If Kiro finds the fix already on the
                  branch from an earlier attempt, that counts as a result, not a failure:
                  the branch goes to validation again.
                </li>
                <li>
                  <strong>REVIEW</strong> — when the attempts are used up or the loop
                  stopped early, the run waits in AWAITING_REVIEW for a person to decide
                  (section 4b).
                </li>
                <li>
                  <strong>REPORT</strong> — the final verdict, phases completed, usage
                  breakdown, and links to the fix branch.
                </li>
              </ol>
              <p>
                The timeline on the run page shows each stage as it happens; the
                pipeline area and run list are separated by a draggable splitter you
                can resize.
              </p>
            </section>

            <section id="guide-approval">
              <h3>4. The human approval gate</h3>
              <p>When a run reaches AWAITING_APPROVAL you choose:</p>
              <ul>
                <li>
                  <strong>Mode</strong> — execute the <em>Simple prompt</em> (Kiro in
                  vibe-code mode with a single instruction) or the <em>Complex spec</em>
                  (the approved Markdown spec is placed at
                  <code> .kiro/specs/adlc-run/approved-spec.md</code> and Kiro is directed to
                  implement it).
                </li>
                <li>
                  <strong>Edit the artifact</strong> — you can modify the drafted prompt
                  or spec before approving. What you approve is frozen: automatic retries
                  reuse it unchanged. Only a reviewer at the review gate can replace it,
                  as a new recorded version (section 4b).
                </li>
                <li>
                  <strong>Execute or Cancel</strong> — cancel ends the run with an
                  audit record; nothing touches the repository.
                </li>
              </ul>
              <p>
                With "Auto-execute simple fixes" checked at submission, a SIMPLE triage
                verdict approves the drafted Simple prompt automatically and the run
                proceeds without pausing. The run history shows it was auto-approved.
                COMPLEX verdicts always stop for review regardless of the checkbox.
              </p>
            </section>

            <section id="guide-review">
              <h3>4b. The review gate (after failed attempts)</h3>
              <p>
                A run that could not reach a green validation on its own stops in
                AWAITING_REVIEW. The review panel shows why it stopped, the build
                comparison (errors added by the fix and pre-existing ones), every
                validator check, the last attempt's summary and a link to the fix branch
                diff. Any signed-in user can decide:
              </p>
              <ul>
                <li>
                  <strong>Accept the fix</strong> — keep the fix branch as it is. A
                  written reason is required. The run continues to security review if it
                  asked for one and ends as ACCEPTED BY REVIEWER, with your name, your
                  reason and the failed checks. It is never shown as a green validation.
                  Accept needs a fix commit; a run whose attempts changed nothing can only
                  be retried or closed.
                </li>
                <li>
                  <strong>Retry with guidance</strong> — write instructions for Kiro (they
                  are added to its prompt for every following attempt), choose 1–3 more
                  attempts, and optionally edit the approved prompt or spec. An edited
                  artifact is saved as a new approved version; the original stays on the
                  run. A run allows at most 9 attempts and 3 review rounds; at the third
                  review only Accept and Close are offered.
                </li>
                <li>
                  <strong>Close the run</strong> — end it without accepting. The run ends
                  as NEEDS HUMAN and the fix branch is kept.
                </li>
              </ul>
              <p>
                If nobody decides within 7 days, the run closes on its own. While a run
                waits for review, the repository reset and fix-branch delete actions are
                blocked, because the run still uses the base commit and its branch. Every
                decision is listed under "Review decisions" on the run page and in the
                timeline.
              </p>
            </section>

            <section id="guide-security">
              <h3>5. Security review (AWS Security Agent)</h3>
              <p>
                After validation passes, the pipeline can optionally run an <strong>AWS
                Security Agent</strong> review against the fix branch. The Security Agent
                performs both a <strong>code review</strong> (static analysis) and a
                <strong>penetration test</strong> (dynamic DAST scanning) in parallel,
                then reports findings with severity levels.
              </p>
              <p>The <strong>Security review</strong> dropdown on the start-run form offers three modes:</p>
              <dl>
                <dt>Skip</dt>
                <dd>
                  No security review is performed. The pipeline goes straight from
                  validation to the final report. Use this for quick iterations where
                  you only care about functional correctness.
                </dd>
                <dt>Scan only (async)</dt>
                <dd>
                  The pipeline kicks off both the code review and the penetration
                  test, then <strong>does not wait</strong> for them to finish. The run
                  completes immediately with its normal report. The security review
                  continues in the background on the AWS Security Agent side — you can
                  check results later in the Security Agent console or on the next
                  poll. This is the default and recommended mode for demos: it shows
                  the integration without adding 20–40 minutes to the run.
                </dd>
                <dt>Scan & remediate</dt>
                <dd>
                  The pipeline starts both reviews and <strong>polls until both
                  complete</strong> (up to 60 minutes). Once finished, findings are
                  collected and shown in the run's security review card. In a future
                  iteration, critical/high findings would be fed back to the coding
                  agent for remediation — today it reports them for human review.
                </dd>
              </dl>
              <p>
                The deployment provisions the Security Agent space (<code>adlc-poc</code>), its
                service role and the UI domain as a verified target domain. If the stack was
                deployed with <code>-c securityAgent=false</code>, the dropdown is disabled and
                every run skips the security review. Penetration tests need the domain to be
                VERIFIED (stack output <code>SecurityAgentDomainVerification</code>); while it
                is not, the pentest is reported as failed to start and the code review still
                runs.
              </p>
              <h4>What runs under the hood</h4>
              <ul>
                <li>
                  <strong>Code review</strong> — static analysis of the source code.
                  Typically completes in 15–30 minutes with ~15 tasks. Each task
                  examines a different aspect of the codebase (architecture, data flow,
                  interfaces, etc.). <strong>Code review is free — no per-hour charge.</strong>
                </li>
                <li>
                  <strong>Penetration test</strong> — dynamic testing that deploys the
                  application, crawls it, then runs targeted attack tasks (XSS, SQL
                  injection, SSRF, path traversal, privilege escalation, etc.).
                  Typically completes in 20–40 minutes with 30–50 tasks.
                  <strong> Pentest is billed at $50 per task-hour.</strong> Each task runs
                  independently (often under 15 minutes each), but there can be many
                  tasks in parallel. A typical pentest run accumulates 5–8 total
                  task-hours, costing <strong>$250–$400 per run</strong>.
                </li>
              </ul>
              <h4>Security review card</h4>
              <p>
                When a security review completes (in "Scan & remediate" mode), the
                run page shows a security card with finding counts by severity
                (Critical, High, Medium, Low) and a pass/fail verdict. The run passes
                security review only if there are zero Critical and zero High findings.
              </p>
            </section>

            <section id="guide-report">
              <h3>6. Reading the report</h3>
              <ul>
                <li>
                  <strong>Headline & phases</strong> — overall outcome, which phases
                  completed, execution mode, models used, fix loops consumed, and total
                  time and cost.
                </li>
                <li>
                  <strong>"How this fix is verified"</strong> — the defense-in-depth
                  panel: frozen artifact, hard build gate, independent validator,
                  bounded three-attempt loop, and the immutable diff. The metrics show
                  the build result and how many validation checks passed.
                </li>
                <li>
                  <strong>Validation findings</strong> — when a fix loop is in progress,
                  the specific findings the agent must address next.
                </li>
                <li>
                  <strong>Inspect fix →</strong> — jumps to the Repository tab, opens
                  the run's before/after review, and scrolls to the verification
                  evidence.
                </li>
              </ul>
            </section>

            <section id="guide-usage">
              <h3>7. Usage & cost breakdown</h3>
              <p>Every completed run includes a detailed cost breakdown. The total
                cost shown at the top is the sum of all measured components:</p>
              <ul>
                <li>
                  <strong>Analysis</strong> — input/output tokens and cost for the
                  TRIAGE and DRAFT calls made with your selected analysis model.
                  Cost depends on the model: Haiku is cheapest, Opus most expensive.
                </li>
                <li>
                  <strong>Kiro</strong> — credits consumed by Kiro CLI per
                  implementation attempt, parsed from Kiro's structured output, with an
                  approximate USD conversion. Runs that predate credit capture show
                  "Unavailable" — the data was never emitted, so it cannot be
                  reconstructed.
                </li>
                <li>
                  <strong>AgentCore</strong> — CPU seconds and peak memory measured
                  inside the container (cgroup v2) for each implementation attempt,
                  plus session IDs and trace IDs for cross-referencing with AWS
                  telemetry.
                </li>
                <li>
                  <strong>Security review</strong> — shown only when security review
                  was not skipped. Displays the total pentest task-hours and cost
                  at <strong>$50 per task-hour</strong>. Code review is free and does
                  not appear in the cost breakdown. The task hours are fetched from
                  the AWS Security Agent API after the pentest completes.
                </li>
              </ul>
              <h4>Typical cost per run</h4>
              <table className="guide-table">
                <thead>
                  <tr><th>Component</th><th>Typical range</th><th>Notes</th></tr>
                </thead>
                <tbody>
                  <tr><td>Analysis (Haiku 5.5)</td><td>under $0.01</td><td>Triage + draft calls</td></tr>
                  <tr><td>Analysis (Sonnet 5.5)</td><td>$0.01 – $0.07</td><td>Triage + draft calls</td></tr>
                  <tr><td>Analysis (Opus 5.5)</td><td>$0.01 – $0.14</td><td>Triage + draft calls</td></tr>
                  <tr><td>Kiro CLI</td><td>$0.50 – $3.00</td><td>Per attempt, depends on complexity</td></tr>
                  <tr><td>AgentCore runtime</td><td>Included</td><td>Container compute (preview pricing)</td></tr>
                  <tr><td>Code review</td><td>Free</td><td>Static analysis, 15–30 min</td></tr>
                  <tr><td>Pentest</td><td>$250 – $400</td><td>$50/task-hour × 5–8 hours typical</td></tr>
                  <tr><td>Decision model</td><td>No per-run charge</td><td>Each endpoint is billed per hour while it is running: CPU $0.922/hour, GPU $2.605/hour; start and stop them in ⚙ Settings (section 14)</td></tr>
                </tbody>
              </table>
              <p className="muted">
                Without security review, a typical bug-fix run costs under $5.
                With pentest enabled, the security review dominates the cost.
              </p>
            </section>

            <section id="guide-repository">
              <h3>8. Repository explorer & fix review</h3>
              <ul>
                <li>
                  <strong>Browse code</strong> — read-only explorer over the demo
                  repository. The revision dropdown switches between <code>main</code> and each
                  run's fix branch.
                </li>
                <li>
                  <strong>Bug jump cards</strong> — one click opens the exact seeded
                  defect lines in the source.
                </li>
                <li>
                  <strong>Fix review</strong> — selecting a fix revision (or arriving
                  via "Inspect fix") shows a full-width before/after comparison per
                  changed file, followed by the verification evidence: validator
                  verdict, build gate, the coding agent's own implementation report
                  (labeled as a claim, not evidence), validation checks, and the raw
                  build output.
                </li>
                <li>
                  <strong>Restore buggy state</strong> — recreates the canonical seeded
                  bugs on <code>main</code> via a new commit. It requires membership in the
                  repo-resetters group and a typed confirmation; fix branches and run
                  history are preserved.
                </li>
                <li>
                  <strong>Delete revision</strong> — permanently removes a fix branch
                  (never <code>main</code>) after a typed confirmation. The run's history and
                  audit records remain.
                </li>
              </ul>
            </section>

            <section id="guide-context">
              <h3>9. Context library</h3>
              <p>
                The <strong>Context</strong> tab is your private library of material the
                analysis model may use during triage: typed text notes, PDFs (such as a
                design document), and images (such as a screenshot of an error).
                Quotas: 10 items, 8 MB total, files up to 4 MB, images up to 3.75 MB.
                Uploads are checked against their declared type and checksum before
                becoming READY.
              </p>
              <p>
                Context is only used for runs started with "Include context" checked,
                and only items that were READY at submission. Context influences
                analysis (triage and drafting) — it is not handed to the coding agent.
              </p>
            </section>

            <section id="guide-mcp">
              <h3>10. MCP servers</h3>
              <p>
                The <strong>MCP</strong> tab lets you give the coding agent extra
                abilities through Model Context Protocol servers. Paste or edit an
                <code> mcp.json</code> document (the same format Kiro uses everywhere); the
                "Insert AWS docs template" button loads a working example that lets
                Kiro search official AWS documentation while it codes.
              </p>
              <ul>
                <li>Limits: up to 5 <code>stdio</code> servers, 32 KB. The editor validates as you type and the server re-validates on save.</li>
                <li>The configuration is snapshotted when a run starts — later edits never affect runs already in flight.</li>
                <li>Inside the container it is written to <code>.kiro/settings/mcp.json</code> for Kiro CLI and removed before the commit, so it never lands in the repository.</li>
                <li>Every MCP tool Kiro actually calls is logged in the run's Agent logs under the <code>mcp</code> stage, including a per-tool call count. If servers were configured but unused, the log says so explicitly.</li>
                <li>The container ships <code>uvx</code> (Python servers) and Node.js (<code>npx</code> servers). MCP servers run with the same trust as the agent — only add servers you trust.</li>
              </ul>
            </section>

            <section id="guide-logs">
              <h3>11. Agent logs</h3>
              <p>
                The bottom of every run page streams the audit log (refreshed every 3
                seconds). Each line has a timestamp, level (INFO/WARN/ERROR), and a
                stage tag: <code>workflow</code>, <code>triage</code>, <code>draft</code>, <code>engine</code>,
                <code> repository</code>, <code>artifact</code>, <code>mcp</code>, <code>kiro</code>, <code>changes</code>,
                <code> build</code>, <code>validation</code>, and <code>agent</code>. This is the fastest way to
                see what actually happened, including Kiro credit usage and MCP tool
                calls.
              </p>
            </section>

            <section id="guide-troubleshooting">
              <h3>12. Troubleshooting & FAQ</h3>
              <dl>
                <dt>Kiro cost shows "Unavailable"</dt>
                <dd>
                  Normal for runs made before structured credit capture was deployed;
                  historical output cannot be reparsed. New runs always show credits.
                </dd>
                <dt>Kiro credits show "Not applicable"</dt>
                <dd>
                  A historical run that did not execute Kiro. Current runs are Kiro
                  CLI only — if the Kiro API key is missing, the run fails with a clear
                  error instead of switching engines.
                </dd>
                <dt>Run failed at TRIAGE or DRAFT</dt>
                <dd>
                  The failure card names the stage and error code (for example, a
                  model rejecting a parameter). Adjust the analysis model or input and
                  start a new run; nothing was executed against the repository.
                </dd>
                <dt>Validation keeps failing</dt>
                <dd>
                  After 3 attempts, or earlier when another attempt cannot help, the run
                  waits in AWAITING_REVIEW. Open it and accept the fix with a reason, retry
                  with guidance, or close it (section 4b). If the build fails only on
                  errors the base commit already had, the build gate passes and the run
                  page lists those errors as pre-existing.
                </dd>
                <dt>The repository looks already fixed</dt>
                <dd>
                  Someone merged or edited <code>main</code>. Use "Restore buggy state" on the
                  Repository tab to recreate the canonical seeded bugs.
                </dd>
                <dt>The decision model option is greyed out</dt>
                <dd>
                  The endpoint the pipeline uses (CPU or GPU, picked in ⚙ Settings) is
                  stopped (the default) or still starting. Deploy it from ⚙ Settings and wait
                  for RUNNING, or pick the other endpoint if that one is running; the status
                  line under the option says which endpoint it checks and its state. See
                  section 14.
                </dd>
                <dt>The decision model disagrees with triage</dt>
                <dd>
                  Expected sometimes: it reads only the bug report, not the code. Look at
                  the highlighted check that decided its verdict and how sure it was, then
                  look at the artifact more closely at the gate. A LOW-certainty result is
                  a weak hint. It never changes what the pipeline does.
                </dd>
                <dt>MCP server did not start</dt>
                <dd>
                  Check the <code>mcp</code> lines in Agent logs. Typical causes: a typo in
                  the command, a package name that does not exist, or a server that
                  needs credentials the container does not have.
                </dd>
              </dl>
            </section>

            <section id="guide-kiro-setup">
              <h3>13. Administrator setup: connecting Kiro CLI</h3>
              <p>
                All code changes are made by <strong>Kiro CLI</strong> running headlessly
                inside the AgentCore container. It authenticates with a Kiro API key
                (<code>ksk_…</code>) that lives in AWS Secrets Manager — it is never stored in
                code, CloudFormation, or the browser. Without a valid key, runs fail at
                the implementation stage with a clear error; there is no fallback engine.
              </p>
              <ol>
                <li>
                  <strong>Get a key</strong> — sign in at{" "}
                  <a href="https://kiro.dev" target="_blank" rel="noreferrer">kiro.dev</a>{" "}
                  with an account that has a Kiro subscription and create an API key
                  (it starts with <code>ksk_</code>). Keys are account-scoped: the models
                  offered in the run form are the models that account can use, and
                  credits consumed by runs are billed to it.
                </li>
                <li>
                  <strong>Store it</strong> — the deployment creates a placeholder secret
                  named <code>adlc-poc/kiro-api-key</code>. Replace its value using AWS
                  credentials for the account hosting the stack:
                  <pre className="guide-code">{`aws secretsmanager put-secret-value \\
  --secret-id adlc-poc/kiro-api-key \\
  --secret-string ksk_YOUR_KEY_HERE \\
  --region us-east-1`}</pre>
                  No redeploy is needed — the agent reads the secret at the start of
                  every invocation.
                </li>
                <li>
                  <strong>Verify</strong> — reload this UI and open the start-run form.
                  The "Implementation model" dropdown should say Kiro models are
                  available and list them. That list is fetched live through the agent
                  container using your key, so seeing it proves the whole chain works.
                </li>
                <li>
                  <strong>Rotate or revoke</strong> — run the same
                  <code> put-secret-value</code> command with a new key at any time. Runs
                  already executing finish with the key they read at invocation start.
                </li>
              </ol>
              <p className="muted">
                Deployment itself (CDK stack, demo user creation, seeding) is covered in
                the repository README.
              </p>
            </section>

            <section id="guide-decision-model">
              <h3>14. Settings: the decision model endpoints (CPU and GPU)</h3>
              <p>
                The second opinion runs on <strong>Strands Decider</strong>
                (<code>strands-decider-12B-gemma4-v1-2610</code>, Apache-2.0) on a private
                Amazon SageMaker real-time endpoint. The same model can run on two endpoints:
              </p>
              <table className="guide-table">
                <thead>
                  <tr><th>Endpoint</th><th>Instance</th><th>Price (us-east-1)</th><th>Answer time</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>CPU, <code>adlc-poc-decider</code></td>
                    <td><code>ml.m5.4xlarge</code></td>
                    <td>$0.922/hour (about $22 a day)</td>
                    <td>About 20 s for a short bug report, 45 s at 2,600 characters; much longer reports can pass SageMaker's 60-second limit</td>
                  </tr>
                  <tr>
                    <td>GPU, <code>adlc-poc-decider-gpu</code></td>
                    <td><code>ml.g6e.xlarge</code> (one NVIDIA L40S)</td>
                    <td>$2.605/hour (about $63 a day)</td>
                    <td>Expected to be a few seconds; not measured yet in this deployment</td>
                  </tr>
                </tbody>
              </table>
              <p>
                The stack deploys everything both endpoints need (weights, images, models and
                endpoint configurations) but <strong>not the endpoints themselves</strong>,
                because each is billed for every hour it exists, whether or not runs use it.
              </p>
              <p>
                GPU instances are sometimes not available. If a GPU deploy ends in FAILED with
                "InsufficientInstanceCapacity", AWS had no free <code>ml.g6e.xlarge</code> at that
                moment: stop (delete) the failed endpoint and deploy it again later. SageMaker
                bills instance time, and a start that failed for lack of capacity never got an
                instance.
              </p>
              <ol>
                <li>
                  <strong>Pick the endpoint the pipeline uses</strong> — the "Endpoint used by
                  the pipeline" panel at the top of ⚙ Settings chooses CPU or GPU (CPU by
                  default). Both endpoints can be running, but a run calls only the one picked
                  here. The choice is recorded on each run when it starts, so changing it does
                  not affect runs already in progress, and the run page shows which endpoint
                  answered. The panel warns when the picked endpoint is not running, and when
                  the other one is running and billed without being used.
                </li>
                <li>
                  <strong>Check an endpoint</strong> — each endpoint has its own panel with the
                  status (STOPPED, STARTING, RUNNING, STOPPING, FAILED), instance type, hourly
                  price, how long it has been running and an estimated cost so far. The page
                  refreshes every 10 seconds while an endpoint is changing.
                </li>
                <li>
                  <strong>Deploy</strong> — creates that endpoint from its endpoint
                  configuration after you confirm the cost. Startup takes about 10 minutes; the
                  run-form option becomes available once the endpoint the pipeline uses is
                  RUNNING (InService).
                </li>
                <li>
                  <strong>Stop (delete)</strong> — deletes that endpoint and ends its billing.
                  The configuration and weights stay, so Deploy works again later. If it is the
                  endpoint the pipeline uses, runs that ask for a second opinion meanwhile
                  record it as unavailable and continue.
                </li>
              </ol>
              <p>
                Any signed-in user can see the status, use Deploy and Stop, and change which
                endpoint the pipeline uses. Every change is recorded in the audit table with
                who made it. If the stack is updated in a way that replaces an endpoint
                configuration, a running endpoint keeps the old one and its panel says so;
                stop it and deploy again. Deleting the stack also deletes both endpoints.
              </p>
              <p className="muted">
                Access is IAM-only: just the decision-model step can call the endpoints, and
                the model containers run with network isolation.
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
