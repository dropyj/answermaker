import type { Project, ProjectEntityType, ProjectLink } from "../types";
import { projectsOf, toggleLink } from "../projects";

/** 列表项上的「所属项目」多选（details 展开勾选，一个实体可属多个项目）。 */
export default function ProjectPicker({
  projects,
  links,
  entityType,
  entityId,
  setLinks,
}: {
  projects: Project[];
  links: ProjectLink[];
  entityType: ProjectEntityType;
  entityId: string;
  setLinks: (next: ProjectLink[]) => void;
}) {
  if (projects.length === 0) return null;
  const mine = projectsOf(links, entityType, entityId);
  const names = projects.filter((p) => mine.includes(p.id)).map((p) => p.name);
  return (
    <details className="proj-pick" onClick={(e) => e.stopPropagation()}>
      <summary>
        <i className="fa-solid fa-diagram-project" aria-hidden="true" /> 项目
        {names.length > 0 ? `：${names.join("、")}` : "：未归属"}
      </summary>
      <div className="proj-pick-list">
        {projects.map((p) => (
          <label key={p.id} className="candidate">
            <input
              type="checkbox"
              checked={mine.includes(p.id)}
              onChange={(e) => setLinks(toggleLink(links, entityType, entityId, p.id, e.target.checked))}
            />
            <span className="proj-dot" style={{ background: p.color }} />
            <span>{p.name}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
