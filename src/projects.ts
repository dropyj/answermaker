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

/** file 与 link 共用同一实体空间（链接是文件的一种），去重/移除时视为同组。 */
export const typeGroup = (t: ProjectEntityType): string => (t === "file" || t === "link" ? "file" : t);

/** 去除重复关联：同一项目里同一实体（file/link 同组）只保留第一条。 */
export function dedupeLinks(links: ProjectLink[]): ProjectLink[] {
  const seen = new Set<string>();
  return links.filter((l) => {
    const key = `${l.projectId}|${typeGroup(l.entityType)}|${l.entityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 某实体是否已关联到该项目（file/link 跨类型判断）。 */
export function isLinked(links: ProjectLink[], entityId: string, projectId: string): boolean {
  return links.some((l) => l.projectId === projectId && l.entityId === entityId);
}

/** 移除某实体在某项目下的全部关联（file/link 两种类型一并移除）。 */
export function removeEntityLinks(links: ProjectLink[], entityId: string, projectId: string): ProjectLink[] {
  return links.filter((l) => !(l.projectId === projectId && l.entityId === entityId));
}

/** 删除项目时只解除关联，不删实体。 */
export function linksWithoutProject(links: ProjectLink[], projectId: string): ProjectLink[] {
  return links.filter((l) => l.projectId !== projectId);
}

/** 实体被删除时清掉它的全部关联。 */
export function linksWithoutEntity(links: ProjectLink[], entityType: ProjectEntityType, entityId: string): ProjectLink[] {
  return links.filter((l) => !(l.entityType === entityType && l.entityId === entityId));
}
