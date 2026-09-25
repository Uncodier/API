export function evaluateScenarioSelection<T extends {
  scenario: string;
  pass: boolean;
}>(scenarios: T[], only?: string[]): {
  selected: T[];
  unresolved: string[];
  ok: boolean;
} {
  const requested = only || [];
  const selected = requested.length > 0
    ? scenarios.filter((scenario) => requested.some((name) =>
        scenario.scenario === name || scenario.scenario.startsWith(name)))
    : scenarios;
  const unresolved = requested.filter((name) =>
    !selected.some((scenario) =>
      scenario.scenario === name || scenario.scenario.startsWith(name)));
  return {
    selected,
    unresolved,
    ok: selected.length > 0 &&
      unresolved.length === 0 &&
      selected.every((scenario) => scenario.pass),
  };
}