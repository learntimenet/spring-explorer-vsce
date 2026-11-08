import { JavaFile } from "../parser/java-parser";
import { BeansMap } from "../types/types";
import { BeanScanner } from "./bean-scanner";
import { DependencyResolver } from "./dependency-resolver";
import { LevelResolver } from "./level-resolver";

/** Turns parsed Java files into beans with resolved dependencies and levels. Has no VS Code dependency. */
export function analyze(files: JavaFile[]): BeansMap {
  const beans = BeanScanner.scan(files);
  DependencyResolver.resolve(beans);
  LevelResolver.resolve(beans);

  const spel = BeanScanner.spelReferences(files);
  for (const bean of beans.values()) {
    if (spel.has(bean.beanName)) {
      bean.used = true;
      bean.tags.push("SpEL");
    }
  }
  return beans;
}
