import { JavaAnnotation, JavaType, unwrapValue } from "../parser/java-parser";
import { Endpoint } from "../types/types";

/** Mapping annotation -> HTTP method (null: read from the "method" attribute). */
const MAPPINGS: Record<string, string | null> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
  RequestMapping: null,
};

export class EndpointUtils {

  /** HTTP endpoints declared by a controller class, combining the class-level @RequestMapping prefix with each handler mapping. */
  static fromController(type: JavaType, constants: Map<string, string>): Endpoint[] {
    const classMapping = type.annotations.find(a => a.name === "RequestMapping");
    const prefixes = classMapping ? EndpointUtils.paths(classMapping, constants) : [""];
    const endpoints: Endpoint[] = [];

    for (const method of type.methods) {
      if (method.isConstructor) continue;
      for (const annotation of method.annotations) {
        if (!(annotation.name in MAPPINGS)) continue;
        const fixed = MAPPINGS[annotation.name];
        const httpMethods = fixed
          ? [fixed]
          : (annotation.values.get("method") ?? []).map(v => unwrapValue(v).split(".").pop()!.toUpperCase());
        if (httpMethods.length === 0) httpMethods.push("ANY");

        for (const prefix of prefixes) {
          for (const path of EndpointUtils.paths(annotation, constants)) {
            for (const httpMethod of httpMethods) {
              endpoints.push({ method: httpMethod, path: EndpointUtils.join(prefix, path), handler: method.name, line: method.line });
            }
          }
        }
      }
    }
    return endpoints;
  }

  private static paths(annotation: JavaAnnotation, constants: Map<string, string>): string[] {
    const paths = [...(annotation.values.get("value") ?? []), ...(annotation.values.get("path") ?? [])];
    return paths.length ? paths.map(p => EndpointUtils.substitute(p, constants)) : [""];
  }

  /** Replaces constant references ("{ApiPaths.USERS}/x") with their values; unknown ones and path variables stay as they are. */
  static substitute(value: string, constants: Map<string, string>, depth = 0): string {
    if (depth > 5) return value;
    return value.replace(/\{([\w$.]+)\}/g, (match, ref: string) => {
      const resolved = constants.get(ref) ?? constants.get(ref.split(".").slice(-2).join("."));
      return resolved === undefined ? match : EndpointUtils.substitute(resolved, constants, depth + 1);
    });
  }

  private static join(prefix: string, path: string): string {
    const joined = `/${prefix}/${path}`.replace(/\/{2,}/g, "/");
    return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
  }

}
