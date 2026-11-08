import { JavaAnnotation, JavaFile, JavaParam, JavaType, JavaTypeRef, unwrapValue } from "../parser/java-parser";
import { Bean, BeanKind, BeansMap, Injection, InjectionVia } from "../types/types";
import { EndpointUtils } from "./endpoint-utils";

/** Class-level annotation -> bean kind. Project annotations meta-annotated with one of these are recognized too. */
const STEREOTYPES: Record<string, BeanKind> = {
  SpringBootApplication: "application",
  Configuration: "configuration",
  AutoConfiguration: "configuration",
  RestController: "controller",
  Controller: "controller",
  Service: "service",
  Repository: "repository",
  Component: "component",
  Named: "component",
  ManagedBean: "component",
  ControllerAdvice: "component",
  RestControllerAdvice: "component",
  FeignClient: "client",
  DgsComponent: "controller",
};

/** When a class carries several stereotypes, the first kind in this list wins. */
const KIND_PRIORITY: BeanKind[] = ["application", "configuration", "controller", "repository", "service", "mapper", "client", "component"];

/** Spring Data base interfaces: project interfaces extending them become repository beans. */
const SPRING_DATA_REPOSITORIES = new Set([
  "Repository", "CrudRepository", "ListCrudRepository", "PagingAndSortingRepository", "ListPagingAndSortingRepository",
  "JpaRepository", "MongoRepository", "ReactiveMongoRepository", "ReactiveCrudRepository", "ReactiveSortingRepository",
  "R2dbcRepository", "ElasticsearchRepository", "CassandraRepository", "Neo4jRepository", "KeyValueRepository",
  "RevisionRepository", "CoroutineCrudRepository", "CoroutineSortingRepository",
]);

const AUTOWIRED = new Set(["Autowired", "Inject"]);

/** Only these kinds can be reported as "unused"; the others are consumed by the framework. */
const INJECTABLE_KINDS = new Set<BeanKind>(["service", "repository", "component", "client", "mapper"]);

/** Beans of these types are called by the framework, not injected by project code. */
const ENTRY_SUPERTYPES = new Set([
  "CommandLineRunner", "ApplicationRunner", "ApplicationListener", "SmartApplicationListener",
  "Filter", "OncePerRequestFilter", "GenericFilterBean", "WebFilter", "HandlerInterceptor", "AsyncHandlerInterceptor",
  "WebMvcConfigurer", "WebFluxConfigurer", "WebSocketConfigurer", "WebSocketMessageBrokerConfigurer",
  "HealthIndicator", "AbstractHealthIndicator", "ReactiveHealthIndicator", "InfoContributor",
  "Converter", "ConverterFactory", "GenericConverter", "Formatter", "ErrorController", "ErrorAttributes", "DefaultErrorAttributes",
  "BeanPostProcessor", "BeanFactoryPostProcessor", "BeanDefinitionRegistryPostProcessor", "ApplicationContextInitializer",
  "SmartLifecycle", "Lifecycle", "HandlerMethodArgumentResolver", "ResponseBodyAdvice", "RequestBodyAdvice",
  "AuthenticationEntryPoint", "AccessDeniedHandler", "AuthenticationSuccessHandler", "AuthenticationFailureHandler",
  "LogoutSuccessHandler", "UserDetailsService", "AuthenticationProvider", "ConstraintValidator", "AuditorAware",
  "Jackson2ObjectMapperBuilderCustomizer", "WebServerFactoryCustomizer", "RestTemplateCustomizer", "AsyncConfigurer",
  "SchedulingConfigurer", "CachingConfigurer", "DataFetcherExceptionHandler", "DataFetcherExceptionResolver",
  "DataFetcherExceptionResolverAdapter", "Instrumentation", "WebGraphQlInterceptor", "Job", "ItemReader", "ItemProcessor", "ItemWriter",
]);

const ENTRY_TYPE_ANNOTATIONS = new Set([
  "ControllerAdvice", "RestControllerAdvice", "Aspect", "Endpoint", "WebEndpoint", "RestControllerEndpoint",
  "WebFilter", "WebServlet", "WebListener", "ServerEndpoint",
]);

const ENTRY_METHOD_ANNOTATIONS = new Set([
  "Scheduled", "Schedules", "EventListener", "TransactionalEventListener", "KafkaListener", "KafkaHandler",
  "RabbitListener", "RabbitHandler", "JmsListener", "SqsListener", "StreamListener", "ServiceActivator",
  "MessageMapping", "SubscribeMapping", "QueryMapping", "MutationMapping", "SchemaMapping", "BatchMapping", "ExceptionHandler",
  "DgsQuery", "DgsMutation", "DgsSubscription", "DgsData",
]);

type TypeEntry = { type: JavaType; file: string; qualifiedName: string };

const has = (annotations: JavaAnnotation[], names: Set<string> | string) =>
  annotations.some(a => (typeof names === "string" ? a.name === names : names.has(a.name)));
const find = (annotations: JavaAnnotation[], name: string) => annotations.find(a => a.name === name);
const literals = (annotation: JavaAnnotation | undefined, ...keys: string[]) =>
  keys.flatMap(k => annotation?.values.get(k) ?? []).filter(v => !v.startsWith("{"));

/** java.beans.Introspector.decapitalize: "UserService" -> "userService", "URLParser" -> "URLParser". */
function decapitalize(name: string): string {
  if (name.length > 1 && name[0] === name[0].toUpperCase() && name[1] === name[1].toUpperCase() && /[A-Z]/.test(name[1])) {
    return name;
  }
  return name.charAt(0).toLowerCase() + name.slice(1);
}

export class BeanScanner {

  static scan(files: JavaFile[]): BeansMap {
    const entries = BeanScanner.flatten(files);
    const byName = new Map<string, TypeEntry[]>();
    for (const entry of entries) {
      if (!byName.has(entry.type.name)) byName.set(entry.type.name, []);
      byName.get(entry.type.name)!.push(entry);
    }

    const stereotypes = BeanScanner.resolveStereotypes(entries);
    const constants = BeanScanner.constants(entries);
    const supertypeCache = new Map<string, Set<string>>();
    const supertypes = (name: string, visiting = new Set<string>()): Set<string> => {
      const cached = supertypeCache.get(name);
      if (cached) return cached;
      const result = new Set<string>();
      if (visiting.has(name)) return result;
      visiting.add(name);
      for (const entry of byName.get(name) ?? []) {
        for (const ref of [...entry.type.extends, ...entry.type.implements]) {
          result.add(ref.name);
          supertypes(ref.name, visiting).forEach(s => result.add(s));
        }
      }
      visiting.delete(name);
      supertypeCache.set(name, result);
      return result;
    };

    const beans: BeansMap = new Map();
    for (const entry of entries) {
      const kind = BeanScanner.kindOf(entry.type, stereotypes, supertypes);
      if (!kind) continue;
      const bean = BeanScanner.classBean(entry, kind, stereotypes, supertypes, constants);
      beans.set(bean.id, bean);

      if (entry.type.kind === "class") {
        for (const method of entry.type.methods) {
          const beanAnnotation = find(method.annotations, "Bean");
          if (!beanAnnotation || !method.returnType) continue;
          const names = literals(beanAnnotation, "name", "value");
          const returnType = method.returnType.name;
          const methodBean: Bean = {
            id: `${entry.file}#${entry.qualifiedName}.${method.name}()`,
            name: method.name,
            typeName: method.returnType.text,
            beanName: names[0] ?? method.name,
            kind: "bean",
            file: entry.file,
            line: method.line,
            types: new Set([returnType, ...supertypes(returnType)]),
            qualifiers: [...names, ...literals(find(method.annotations, "Qualifier"), "value")],
            primary: has(method.annotations, "Primary"),
            entryPoint: true,
            tags: BeanScanner.tags(method.annotations),
            injections: method.params.flatMap(p => BeanScanner.injection(p.type, p.name, "bean-method", p.annotations)),
            dependencies: [],
            external: [],
            endpoints: [],
            declaredBy: bean,
            level: -1,
            used: false,
          };
          beans.set(methodBean.id, methodBean);
        }
      }
    }
    return beans;
  }

  /** Bean names referenced from SpEL in annotation values, e.g. @PreAuthorize("hasRole(@roles.ADMIN)") -> "roles". */
  static spelReferences(files: JavaFile[]): Set<string> {
    const names = new Set<string>();
    const scan = (annotations: JavaAnnotation[]) => {
      for (const a of annotations) {
        for (const values of a.values.values()) {
          for (const v of values) {
            for (const m of v.matchAll(/@([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
          }
        }
      }
    };
    const visit = (type: JavaType) => {
      scan(type.annotations);
      type.fields.forEach(f => scan(f.annotations));
      type.methods.forEach(m => {
        scan(m.annotations);
        m.params.forEach(p => scan(p.annotations));
      });
      type.nested.forEach(visit);
    };
    files.forEach(f => f.types.forEach(visit));
    return names;
  }

  /** String constants by "Class.FIELD" (and "Outer.Inner.FIELD"), plus bare "FIELD" when unambiguous, for resolving mapping paths. */
  private static constants(entries: TypeEntry[]): Map<string, string> {
    const map = new Map<string, string>();
    const bare = new Map<string, string | null>();
    for (const { type, qualifiedName } of entries) {
      const isInterface = type.kind === "interface" || type.kind === "annotation";
      for (const field of type.fields) {
        if (field.constantValue === undefined) continue;
        if (!isInterface && !(field.modifiers.includes("static") && field.modifiers.includes("final"))) continue;
        map.set(`${qualifiedName}.${field.name}`, field.constantValue);
        map.set(`${type.name}.${field.name}`, field.constantValue);
        bare.set(field.name, bare.has(field.name) && bare.get(field.name) !== field.constantValue ? null : field.constantValue);
      }
    }
    for (const [name, value] of bare) {
      if (value !== null && !map.has(name)) map.set(name, value);
    }
    return map;
  }

  private static flatten(files: JavaFile[]): TypeEntry[] {
    const entries: TypeEntry[] = [];
    const visit = (type: JavaType, file: string, outer: string) => {
      const qualifiedName = outer ? `${outer}.${type.name}` : type.name;
      entries.push({ type, file, qualifiedName });
      type.nested.forEach(n => visit(n, file, qualifiedName));
    };
    files.forEach(f => f.types.forEach(t => visit(t, f.file, "")));
    return entries;
  }

  /** Adds project annotations that are meta-annotated with a stereotype, e.g. @UseCase annotated with @Service. */
  private static resolveStereotypes(entries: TypeEntry[]): Map<string, BeanKind> {
    const map = new Map<string, BeanKind>(Object.entries(STEREOTYPES));
    const annotationTypes = entries.filter(e => e.type.kind === "annotation");
    let changed = true;
    while (changed) {
      changed = false;
      for (const { type } of annotationTypes) {
        if (map.has(type.name)) continue;
        const meta = type.annotations.find(a => map.has(a.name));
        if (meta) {
          map.set(type.name, map.get(meta.name)!);
          changed = true;
        }
      }
    }
    return map;
  }

  private static kindOf(type: JavaType, stereotypes: Map<string, BeanKind>, supertypes: (n: string) => Set<string>): BeanKind | null {
    if (type.kind === "annotation" || type.kind === "enum") return null;

    // MyBatis and MapStruct mappers: interfaces or abstract classes implemented at build/run time.
    if (has(type.annotations, "Mapper")) return "mapper";

    if (type.kind === "interface") {
      if (has(type.annotations, "FeignClient")) return "client";
      if (has(type.annotations, "NoRepositoryBean")) return null;
      // Plain interfaces are never component-scanned, even with @Repository; Spring Data ones are.
      return [...supertypes(type.name)].some(s => SPRING_DATA_REPOSITORIES.has(s)) ? "repository" : null;
    }

    if (type.modifiers.includes("abstract")) return null;
    const kinds = type.annotations.map(a => stereotypes.get(a.name)).filter((k): k is BeanKind => !!k);
    return KIND_PRIORITY.find(k => kinds.includes(k)) ?? null;
  }

  private static classBean(
    entry: TypeEntry,
    kind: BeanKind,
    stereotypes: Map<string, BeanKind>,
    supertypes: (n: string) => Set<string>,
    constants: Map<string, string>,
  ): Bean {
    const { type, file } = entry;
    const stereotype = type.annotations.find(a => stereotypes.has(a.name) && a.name !== "FeignClient");
    const explicitName = literals(stereotype, "value")[0];
    const types = new Set([type.name, ...supertypes(type.name)]);

    const entryPoint = !INJECTABLE_KINDS.has(kind)
      || has(type.annotations, ENTRY_TYPE_ANNOTATIONS)
      || [...types].some(t => ENTRY_SUPERTYPES.has(t))
      || type.methods.some(m => has(m.annotations, ENTRY_METHOD_ANNOTATIONS));

    return {
      id: `${file}#${entry.qualifiedName}`,
      name: type.name,
      typeName: type.name,
      beanName: explicitName ?? decapitalize(type.name),
      kind,
      file,
      line: type.line,
      types,
      qualifiers: literals(find(type.annotations, "Qualifier"), "value"),
      primary: has(type.annotations, "Primary"),
      entryPoint,
      tags: BeanScanner.tags(type.annotations),
      injections: type.kind === "class" || type.kind === "record" ? BeanScanner.injections(type) : [],
      dependencies: [],
      external: [],
      endpoints: kind === "controller" ? EndpointUtils.fromController(type, constants) : [],
      level: -1,
      used: false,
    };
  }

  /** Injection points of a class: constructor (explicit, implicit, record or Lombok-generated), fields and setters. */
  private static injections(type: JavaType): Injection[] {
    const result: Injection[] = [];
    const add = (params: { name: string; type: JavaTypeRef; annotations: JavaAnnotation[] }[], via: InjectionVia) =>
      params.forEach(p => result.push(...BeanScanner.injection(p.type, p.name, via, p.annotations)));

    const constructors = type.methods.filter(m => m.isConstructor);
    const autowired = constructors.filter(c => has(c.annotations, AUTOWIRED));
    const chosen = autowired.length ? autowired : constructors.length === 1 ? constructors : [];
    chosen.forEach(c => add(c.params, "constructor"));

    if (constructors.length === 0) {
      const instanceFields = type.fields.filter(f => !f.modifiers.includes("static"));
      if (type.kind === "record") {
        add(type.recordComponents, "constructor");
      } else if (has(type.annotations, "RequiredArgsConstructor")) {
        add(instanceFields.filter(f => (f.modifiers.includes("final") && !f.hasInitializer) || has(f.annotations, "NonNull")), "constructor");
      } else if (has(type.annotations, "AllArgsConstructor")) {
        add(instanceFields.filter(f => !(f.modifiers.includes("final") && f.hasInitializer)), "constructor");
      }
    }

    add(type.fields.filter(f => has(f.annotations, AUTOWIRED) || has(f.annotations, "Resource")), "field");

    for (const method of type.methods) {
      if (!method.isConstructor && (has(method.annotations, AUTOWIRED) || has(method.annotations, "Resource"))) {
        const resourceName = literals(find(method.annotations, "Resource"), "name")[0];
        const params: JavaParam[] = method.params.map(p =>
          resourceName ? { ...p, annotations: [...p.annotations, ...method.annotations.filter(a => a.name === "Resource")] } : p);
        add(params, "setter");
      }
    }
    return result;
  }

  private static injection(type: JavaTypeRef, name: string, via: InjectionVia, annotations: JavaAnnotation[]): Injection[] {
    if (has(annotations, "Value")) return [];
    const qualifier = literals(find(annotations, "Qualifier"), "value")[0]
      ?? literals(find(annotations, "Named"), "value")[0]
      ?? literals(find(annotations, "Resource"), "name")[0];
    return [{ type, name, via, qualifier }];
  }

  private static tags(annotations: JavaAnnotation[]): string[] {
    const tags: string[] = [];
    for (const a of annotations) {
      const values = (a.values.get("value") ?? []).map(unwrapValue);
      if (a.name === "Primary" || a.name === "Lazy" || a.name === "Transactional" || a.name === "Async" || a.name === "Validated") {
        tags.push(`@${a.name}`);
      } else if (a.name === "Profile" || a.name === "Scope") {
        tags.push(`@${a.name}(${values.join(", ")})`);
      } else if (a.name.startsWith("ConditionalOn")) {
        tags.push(`@${a.name}`);
      }
    }
    return tags;
  }

}
