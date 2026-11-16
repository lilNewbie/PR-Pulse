// Stubs — full implementation in us-12-deploy-trace

export async function recordDeploymentEvent(
  _repoId: number,
  _payload: unknown,
): Promise<number | null> {
  return null
}

export async function linkDeployment(
  _deploymentId: number,
): Promise<{ prCount: number; previousDeploymentId: number | null }> {
  return { prCount: 0, previousDeploymentId: null }
}
