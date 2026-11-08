import { JavaTypeRef } from "../parser/java-parser";
import { Bean, BeansMap, Injection } from "../types/types";

/** Containers whose element type is what actually gets injected; all matching beans are injected. */
const COLLECTIONS = new Set(["List", "Set", "Collection", "Iterable", "SortedSet", "Stream"]);
/** Wrappers around a single injected bean. */
const WRAPPERS = new Set(["Optional", "ObjectProvider", "ObjectFactory", "Provider", "Lazy", "Supplier"]);
/** Types that are never project beans (usually @Value-like configuration). */
const SKIPPED = new Set([
  "byte", "short", "int", "long", "float", "double", "boolean", "char",
  "Byte", "Short", "Integer", "Long", "Float", "Double", "Boolean", "Character", "Number",
  "String", "CharSequence", "Object", "Class", "BigDecimal", "BigInteger", "UUID",
  "Duration", "Instant", "LocalDate", "LocalDateTime", "LocalTime", "ZonedDateTime", "Date",
]);

function unwrap(type: JavaTypeRef): { type: JavaTypeRef | undefined; multi: boolean } {
  if (type.array) return { type: { ...type, array: false }, multi: true };
  if (COLLECTIONS.has(type.name)) return { type: type.args[0], multi: true };
  if (type.name === "Map") return { type: type.args[1], multi: true };
  if (WRAPPERS.has(type.name) && type.args[0]) return unwrap(type.args[0]);
  return { type, multi: false };
}

export class DependencyResolver {

  /** Resolves each bean's injection points to project beans, then marks injected beans as used. */
  static resolve(beans: BeansMap): void {
    const index = new Map<string, Bean[]>();
    for (const bean of beans.values()) {
      for (const type of bean.types) {
        if (!index.has(type)) index.set(type, []);
        index.get(type)!.push(bean);
      }
    }

    for (const bean of beans.values()) {
      const dependencies = new Set<Bean>();
      const external = new Set<string>();
      for (const injection of bean.injections) {
        const resolved = DependencyResolver.candidates(bean, injection, index);
        if (resolved === null) continue;
        if (resolved.length === 0) external.add(injection.type.text);
        resolved.forEach(d => dependencies.add(d));
      }
      bean.dependencies = [...dependencies];
      bean.external = [...external].sort();
    }

    for (const bean of beans.values()) {
      bean.dependencies.forEach(d => (d.used = true));
    }
  }

  /** Beans satisfying an injection point; null when the type is never a bean (String, int, type variables…). */
  private static candidates(bean: Bean, injection: Injection, index: Map<string, Bean[]>): Bean[] | null {
    const { type, multi } = unwrap(injection.type);
    if (!type || SKIPPED.has(type.name) || /^[A-Z]$/.test(type.name)) return null;

    let candidates = (index.get(type.name) ?? []).filter(c => c !== bean);
    const qualifier = injection.qualifier;
    if (qualifier) {
      candidates = candidates.filter(c => c.beanName === qualifier || c.qualifiers.includes(qualifier));
    }
    if (multi || candidates.length <= 1) return candidates;

    // Same rules Spring uses to pick one of several candidates: @Primary, then the parameter/field name.
    const primary = candidates.filter(c => c.primary);
    if (primary.length === 1) return primary;
    const byName = candidates.filter(c => c.beanName === injection.name);
    if (byName.length === 1) return byName;
    return candidates;
  }

}
