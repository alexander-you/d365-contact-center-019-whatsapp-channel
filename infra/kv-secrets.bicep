// Writes secrets to Key Vault through the ARM control plane.
// Used because the tenant policy keeps the Key Vault data plane private.
param keyVaultName string

@secure()
@description('JSON object: { "<secret-name>": "<value>", ... }')
param secretsJson string

var secrets = json(secretsJson)

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource kvSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [for s in items(secrets): {
  parent: kv
  name: s.key
  properties: { value: s.value }
}]

output names array = [for s in items(secrets): s.key]
