//
//  plantuml-palette.test.ts
//  md.vscode — which PlantUML diagrams are drawn in the light palette, on a
//  light card, in a dark theme: those that paint light fills of their own, which
//  the engine's white dark-palette text cannot be read on (2026-10-09, a
//  sequence diagram with four pastel `box` groups that came up empty).
//

import { describe, expect, it } from 'vitest';

import { paintsOwnLightFills } from '../src/render/plantuml-palette';

const uml = (...lines: string[]) => ['@startuml', ...lines, '@enduml'].join('\n');

describe('paintsOwnLightFills', () => {
  it('is true for light fills of the author\'s own', () => {
    for (const source of [
      uml('box "Production host" #F4F8FF', '  participant A', 'end box'),
      uml('participant X #LightBlue'),
      uml('participant X #FFF'),
      uml('note over A #FFFFCC: hi'),
      uml('skinparam BackgroundColor #EEEEEE'),
      uml('skinparam sequenceBoxBackgroundColor Wheat'),
      uml('<style>', 'note {', '  BackGroundColor #ffffcc', '}', '</style>'),
      uml('participant X #navy/LightYellow'),
    ]) {
      expect(paintsOwnLightFills(source), source).toBe(true);
    }
  });

  it('is false for no colours, dark fills, arrow ink and text that merely holds a #', () => {
    for (const source of [
      uml('Alice -> Bob : hello'),
      uml('participant X #333333', 'participant Y #Navy'),
      uml('A -[#red]> B', 'B <-[#00FF00]- A'),
      uml('participant "Issue #N" as I', 'participant "#FFFFFF" as W'),
      uml('A -> B : fixes #FFF and #LightBlue'),
      uml("' box \"x\" #FFFFFF", "/' participant X #FFF '/", 'A -> B'),
      uml('skinparam BackgroundColor transparent'),
      uml('skinparam BackgroundColor none'),
    ]) {
      expect(paintsOwnLightFills(source), source).toBe(false);
    }
  });
});
