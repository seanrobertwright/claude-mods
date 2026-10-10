// Hand-built workflow YAML, shaped like Archon's bundled workflows
// (docs/research/archon-run-data.md § Shape of the bundled workflows) and the
// archon-cli skill's node reference: a review fan-out with a skip edge, an
// include block, a loop group, an approval with decisions, and a workflow node.

export const REVIEW = `name: archon-review
description: |
  Review a change: six reviewers in parallel,
  joined by one node.
interactive: false
nodes:
  - id: mode
    bash: echo review
  - id: scope
    command: scope # what to review
    depends_on: [mode]
  - id: code
    command: review-code
    depends_on: [scope]
  - id: seams
    command: review-seams
    depends_on: [scope]
  - id: simplify
    command: review-simplify
    depends_on: [scope]
  - id: tests
    command: review-tests
    depends_on: [scope]
  - id: errors
    command: review-errors
    depends_on: [scope]
  - id: docs
    command: review-docs
    depends_on: [scope]
  - id: review-complete
    bash: "echo 'all six: done'"
    depends_on:
      - code
      - seams
      - simplify
      - tests
      - errors
      - docs
  - id: synthesize
    prompt: >
      Fold the six reviews
      into one report.
    depends_on: [scope, review-complete]
  - id: publish
    command: publish
    depends_on: [synthesize]
`

export const DELIVER = `name: archon-deliver
nodes:
  - id: implement
    command: implement
  - id: fix-1
    command: fix
    depends_on: [implement]
`

export const SHIP = `name: archon-ship
interactive: true
nodes:
  - id: plan
    command: plan
  - id: deliver
    include: archon-deliver
    depends_on: [plan]
  - id: fix-cycle
    depends_on: [deliver]
    loop_group:
      nodes:
        - id: fix
          prompt: "Address findings"
        - id: recheck
          prompt: Verify each finding
          depends_on: [fix]
      until_bash: 'test "$recheck.output.ready" = "true"'
      max_iterations: 5
  - id: review-gate
    approval:
      message: "Review before proceeding"
      decisions:
        - {id: approve, label: Approve}
        - {id: needs-revision, label: Needs revision}
        - id: reject
          label: Reject
    depends_on: [fix-cycle]
  - id: child
    workflow: archon-fix
    depends_on: [review-gate]
`
