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
