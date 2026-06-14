export function choosePipelineIdAfterLogRefresh(
  pipelines: { id: string }[],
  pendingPipelineId: string | null,
  selectedPipelineId: string | null,
): string | undefined {
  if (pendingPipelineId && pipelines.some(item => item.id === pendingPipelineId)) {
    return pendingPipelineId;
  }
  if (selectedPipelineId && pipelines.some(item => item.id === selectedPipelineId)) {
    return selectedPipelineId;
  }
  return pipelines[0]?.id;
}

export function chooseLogItemIdAfterRefresh(
  items: { id: string }[],
  pendingItemId: string | null,
  selectedItemId: string | null,
): string | undefined {
  if (pendingItemId) return pendingItemId;
  if (selectedItemId && items.some(item => item.id === selectedItemId)) {
    return selectedItemId;
  }
  return undefined;
}
