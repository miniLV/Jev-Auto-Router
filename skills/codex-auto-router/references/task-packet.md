# Worker Task Packet

Give the Worker a self-contained prompt. Do not assume it has the Main Task
history.

```markdown
# Worker identity

You are one bounded execution Worker. Do not create any child Agent, background
task, or thread.

## Objective

- Main objective:
- Your bounded responsibility:
- Why this unit is independent:

## Scope

- Read:
- Write: exact Worker-owned paths only
- Do not touch:
- File ownership:
- Preflight baseline for every writable path:

## Known facts and constraints

- Relevant facts:
- User constraints:
- Upstream Skill requirements:
- Assumptions already confirmed by Root:

## Acceptance

- Required result:
- Mechanical verification to run:
- Return format:
- If information is missing: report the exact gap; do not expand scope or guess.
```

Include only the context required for the bounded responsibility. Prefer source
pointers over a copied conversation. Preserve upstream output paths, stage
dependencies, and acceptance criteria exactly. Every writable path must be
exclusive to the Worker and have a captured preflight baseline. Root must not
edit those paths while the Worker is active.

Root records the Route Decision and selected route tuple outside the Task
Packet. The Worker never selects or changes its own model or reasoning effort.

The Worker response must contain:

1. conclusion or implemented result;
2. evidence and exact changed files;
3. verification performed and result;
4. remaining risks or missing information.
