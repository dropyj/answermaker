import type { ProjectLink, ProjectEntityType } from "./types";
import { uid } from "./types";

/** 某实体所属的项目 id 列表。 */
export function projectsOf(links: ProjectLink[], entityType: ProjectEntityType, entityId: string): string[] {
  return links.filter((l) => l.entityType === entityType && l.entityId === entityId).map((l) => l.projectId);
}

/** 切换一条实体↔项目关联，返回新 links。 */
export function toggleLink(
  links: ProjectLink[],
  entityType: ProjectEntityType,
  entityId: string,
  projectId: string,
  on: boolean,
): ProjectLink[] {
  const exists = links.some((l) => l.entityType === entityType && l.entityId === entityId && l.projectId === projectId);
  if (on && !exists) return [...links, { id: uid(), entityType, entityId, projectId }];
  if (!on && exists) return links.filter((l) => !(l.entityType === entityType && l.entityId === entityId && l.projectId === projectId));
  return links;
}

/** 删除项目时只解除关联，不删实体。 */
export function linksWithoutProject(links: ProjectLink[], projectId: string): ProjectLink[] {
  return links.filter((l) => l.projectId !== projectId);
}

/** 实体被删除时清掉它的全部关联。 */
export function linksWithoutEntity(links: ProjectLink[], entityType: ProjectEntityType, entityId: string): ProjectLink[] {
  return links.filter((l) => !(l.entityType === entityType && l.entityId === entityId));
}
