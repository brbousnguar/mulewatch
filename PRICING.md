# Positioning & pricing — mulewatch

**Recommendation: ship it Apache-2.0 open source, positioned as consulting lead-gen.
Do not sell it as a template, and do not build a hosted version.**

The reasoning below is driven by one finding that came out of the research, not by a
general preference for open source.

## The finding that decides it

MuleSoft (Salesforce) already ships an official MCP server. It is on npm as
`mulesoft-mcp-server`, published under the `mulesoft-emu` org, homepage
`docs.mulesoft.com/mulesoft-mcp-server`. It was at v1.3.9 and last modified
2026-09-04 — four days before this note. It is actively maintained.

Its bundled tool set already covers three of the four surfaces in the original brief:

| Surface | Official server | Verdict |
|---|---|---|
| API Manager | `list_api_instances`, `create_and_manage_api_instances`, `manage_api_instance_policy` | Covered |
| Exchange | `create_and_manage_assets` | Covered |
| Runtime Manager deployment | `deploy_mule_application`, `list_applications` | Covered |
| **Application logs / monitoring archive** | **nothing** | **Open** |

That last row is the whole product thesis. Grepping the published bundle for log
retrieval returns only `logger`, `logstash` and security-pattern strings — there is no
tool that fetches application logs, and nothing that touches the Anypoint Monitoring
Archive API.

**Selling a paid product that overlaps a vendor's free first-party tool has no path
through enterprise procurement.** A buyer's platform team will ask "why not the
MuleSoft one?" and any answer that starts with "mine also does deploys" loses.

## Where the defensible ground actually is

Two gaps in the official server are real and durable enough to build on.

**1. It has no log retrieval at all.** Live-tail logs are a small rolling buffer that
scrolls out within minutes on a busy app. Getting at anything older means the Monitoring
Archive API, which indexes per *replica* (`{appName}_{replicaId}`), not per app — so
answering "what happened at 03:00 last Tuesday" requires resolving which replicas existed
then, probing each, and staying under a 60 req/min rate limit. That is the hard part, it
is already solved in this codebase, and the vendor has shown no interest in it.

**2. It is dev-workstation-shaped; this is ops-shaped.** The official bundle carries 26
references to `pom.xml` and 21 to `mule-artifact`, plus `create_mule_project` and
`mule-xml-debugger` tools, and its own README frames it as "Cursor and Windsurf IDE
integration". It assumes you have a Mule project checked out. The person debugging a
3 a.m. production incident does not. Different tool, different user, same platform —
worth stating in one sentence rather than pretending it's a competitor.

**3. It is not open source.** `LICENSE.txt` places it under the Salesforce Main Services
Agreement, with no redistribution or modification grant. A customer cannot fork it, audit
it, or vendor it into an air-gapped environment. Apache-2.0 is a genuine differentiator
here, and it is exactly the kind of thing a platform-security review blocks procurement
over — independent of any feature comparison.

## Why not the other two models

**One-time paid template (~$49–299).** A wrapper over a documented REST API has no
defensibility as an artifact — anyone can regenerate it, increasingly with an LLM in an
afternoon. Worse, enterprise procurement cannot process a $49 line item; the transaction
cost exceeds the price. And you would be charging for something adjacent to a free
first-party tool. This model raises negligible revenue and costs you the distribution
that makes the tool useful.

**Open-core + paid hosted.** Hosting means holding customers' Anypoint connected-app
credentials — credentials that read production logs across their whole estate. Enterprise
Mule shops are precisely the buyers who will not put production platform secrets in a solo
developer's SaaS. You would be taking on the security, compliance and liability burden of
a credential custodian in exchange for the customers least likely to accept it. The
economics are inverted: the model's cost is highest exactly where its market is thinnest.

## The recommended model, concretely

Free, Apache-2.0, published to npm and the MCP registry. The monetizable unit is **your
time**, not the artifact.

The logic: a wrapper has no scarcity, but a working MuleSoft engineer with credibility in
front of enterprise platform teams buying agentic-AI engagements is scarce. Free
distribution compounds — registry listings, npx installs, GitHub stars and inbound issues
are all lead flow into a consulting funnel where the billable unit is a day rate, not a
license. One engagement outearns any realistic template revenue, and the tool is what
gets you in the room.

Practical steps to make that funnel actually work:

- Author identity front and centre in README and npm metadata; the tool should read as
  *someone's*, not anonymous infrastructure.
- A one-line "built by a MuleSoft integration engineer — available for platform and
  agentic-AI consulting" in the README footer, with a contact route.
- Write up the archive replica-resolution problem as a public post. That is the artifact
  that demonstrates expertise; the repo is the proof it works.
- Watch the issue tracker as a demand signal. Enterprise users filing detailed issues are
  qualified leads.

## What to keep on the shelf

Do **not** build a paid tier on day one. Keep one on the shelf and gate it on evidence of
inbound demand.

The obvious candidates — audit logging, RBAC, centrally enforced environment allowlisting —
are a trap: they are precisely what Salesforce will add next, and building there means
being overwritten by the vendor's roadmap.

The durable shelf item is **log-forensics depth**, where the vendor has shown no interest
and where the hard code already exists: long-retention archive search, cross-application
incident timelines, correlation across replicas and environments, and scheduled extraction
into a customer's own SIEM or object storage. If that gets asked for repeatedly by people
who have already installed the free server, that is the moment to build it — and by then
you will know what to charge, because they will have told you what it is worth.
