import { JavaTypeRef } from "../parser/java-parser";

export type BeanKind =
  | "application"
  | "configuration"
  | "controller"
  | "service"
  | "repository"
  | "component"
  | "client"
  | "mapper"
  | "bean";

export type InjectionVia = "constructor" | "field" | "setter" | "bean-method";

export type Injection = {
  type: JavaTypeRef;
  name: string;
  via: InjectionVia;
  qualifier?: string;
};

export type Endpoint = {
  method: string;
  path: string;
  handler: string;
  line: number;
};

export type Bean = {
  /** Unique id: "<file>#<Class>" or "<file>#<Class>.<method>()" for @Bean methods. */
  id: string;
  /** Display name: the class name, or the method name for @Bean methods. */
  name: string;
  /** The bean's class (or @Bean return type). */
  typeName: string;
  /** Spring bean name, e.g. "userService". */
  beanName: string;
  kind: BeanKind;
  file: string;
  line: number;
  /** Every type name this bean can be injected as (class, superclasses, interfaces). */
  types: Set<string>;
  qualifiers: string[];
  primary: boolean;
  /** Invoked by the framework rather than injected (controllers, listeners, runners…), so never "unused". */
  entryPoint: boolean;
  /** Notable annotations shown as tags, e.g. "@Primary", "@Profile(dev)". */
  tags: string[];
  injections: Injection[];
  dependencies: Bean[];
  /** Injected types that no project bean provides (framework or library beans). */
  external: string[];
  endpoints: Endpoint[];
  declaredBy?: Bean;
  level: number;
  /** Injected by at least one other project bean. */
  used: boolean;
};

export type BeansMap = Map<string, Bean>;
