# Spring Explorer

Scans your workspace and shows your Spring beans in a dedicated editor panel, grouped by **dependency level**: the length of the longest chain of project beans each one injects.

- **Level 0** — beans that inject no other project bean (repositories, mappers, leaf services…)
- **Level N** — beans whose deepest injected dependency is at level N − 1 (controllers usually sit at the top)

## Usage

Run `Spring Explorer: Open` from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), or right-click a `.java` file and choose **Spring Explorer: Reveal Bean**.
The workspace is analyzed the first time the panel opens; use the ⟳ button to re-analyze after changes.

## Views

- **Board** — one column per stereotype (controllers, services, repositories…). Select a bean to highlight what it injects (green) and what injects it (purple).
- **Hierarchy** — top-level beans (not injected by any other bean, typically controllers) at the root; expand one to see what it injects, recursively. Circular dependencies are marked `↻ circular`.
- **Endpoints** — every HTTP endpoint grouped by controller, with its method and full path (class-level `@RequestMapping` prefix included). Click one to jump to its handler.

## What is detected

- **Beans** — `@Component`, `@Service`, `@Repository`, `@Controller`, `@RestController`, `@Configuration`, `@SpringBootApplication`, `@ControllerAdvice`, `@Named`, custom stereotype annotations (e.g. `@UseCase` meta-annotated with `@Service`), `@Bean` methods, Spring Data repository interfaces, MyBatis/MapStruct `@Mapper`s, `@FeignClient`s and DGS `@DgsComponent`s
- **Injection** — constructor injection (explicit, single implicit constructor, records, Lombok `@RequiredArgsConstructor` / `@AllArgsConstructor`), `@Autowired` / `@Inject` / `@Resource` fields and setters, and `@Bean` method parameters
- **Resolution** — interfaces resolve to their implementations, honoring `@Qualifier`, `@Primary` and bean names; `List<T>`, `Set<T>`, `Map<String, T>`, `Optional<T>` and `ObjectProvider<T>` are unwrapped
- **External dependencies** — injected types no project bean provides (`JdbcTemplate`, `RestTemplate`…) are listed in the details pane

## Features

- Details pane for the selected bean: bean name, stereotype, level, injects, injected by, external dependencies, endpoints, and notable annotations (`@Primary`, `@Profile`, `@Transactional`…)
- Filter by name and an **Unused only** toggle: services, components, repositories, mappers and clients no project bean injects. Framework-invoked beans (controllers, configurations, listeners, `@Scheduled` jobs, filters, runners, beans referenced from SpEL…) are never reported as unused.
- Follows the active editor: switching files selects that file's bean
- Double-click a bean (or use **Open file**) to open its source beside the panel
- No Java language server or build required — sources are parsed directly; uses your VS Code theme colors

## Limitations

The analysis is static and source-based: beans registered programmatically, through auto-configuration from libraries, or conditionally (`@Profile`, `@ConditionalOn…`) are shown as declared, without evaluating which ones would be active. Test sources (`src/test`) are ignored.

## Feedback

If you have suggestions or encounter issues, please open an issue in the repository.

## License

MIT
