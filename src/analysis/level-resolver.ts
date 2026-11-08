import { Bean, BeansMap } from "../types/types";

export class LevelResolver {

  /** Level = length of the longest chain of project beans a bean depends on (cycles count as level 0). */
  static resolve(beans: BeansMap): void {
    const visiting = new Set<string>();

    const computeLevel = (bean: Bean): number => {
      if (bean.level !== -1) return bean.level;
      if (visiting.has(bean.id)) return 0; // circular dependency

      visiting.add(bean.id);
      bean.level = bean.dependencies.length === 0 ? 0 : Math.max(...bean.dependencies.map(computeLevel)) + 1;
      visiting.delete(bean.id);
      return bean.level;
    };

    for (const bean of beans.values()) {
      computeLevel(bean);
    }
  }

}
