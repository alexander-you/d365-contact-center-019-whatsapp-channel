// WhatsApp (019) <-> Dynamics 365 Contact Center custom channel - Azure baseline
targetScope = 'resourceGroup'

@description('Azure region')
param location string = resourceGroup().location

@description('Short environment suffix, e.g. dev, test, prod')
param env string = 'dev'

@description('Resource name prefix')
param namePrefix string = 'wa019'

@description('Object id of the deploying admin (gets Key Vault Secrets Officer)')
param adminObjectId string

var base = '${namePrefix}-${env}'
var storageName = toLower(replace('st${namePrefix}${env}${uniqueString(resourceGroup().id)}', '-', ''))
var tags = { solution: 'd365-contact-center-019-whatsapp-channel' }

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${base}'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${base}'
  location: location
  kind: 'web'
  tags: tags
  properties: { Application_Type: 'web', WorkspaceResourceId: law.id }
}

resource st 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take(storageName, 24)
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  tags: tags
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    // Tenant policy enforces private access; the app reaches storage through private endpoints.
    publicNetworkAccess: 'Disabled'
  }
}

resource blobSvc 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: st
  name: 'default'
}

resource deployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobSvc
  name: 'deployments'
}

resource tableSvc 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: st
  name: 'default'
}

var tableNames = [ 'Conversations', 'ConvIndex', 'PendingOptions', 'MsgMap', 'Dedupe', 'OptOut', 'OutboundLog' ]
resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [for t in tableNames: {
  parent: tableSvc
  name: t
}]

resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: 'sb-${base}'
  location: location
  sku: { name: 'Standard', tier: 'Standard' }
  tags: tags
  properties: { minimumTlsVersion: '1.2', disableLocalAuth: true }
}

var queues = [
  { name: 'sb-inbound', session: true }
  { name: 'sb-outbound', session: true }
  { name: 'sb-status', session: false }
]
resource sbQueues 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = [for q in queues: {
  parent: sb
  name: q.name
  properties: {
    requiresSession: q.session
    maxDeliveryCount: 5
    lockDuration: 'PT1M'
    defaultMessageTimeToLive: 'P1D'
    deadLetteringOnMessageExpiration: true
  }
}]

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${base}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Disabled'
  }
}

// --- Network: required because the tenant policy disables public access on Storage and Key Vault
resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: 'vnet-${base}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [ '10.40.0.0/24' ] }
    subnets: [
      {
        name: 'snet-func'
        properties: {
          addressPrefix: '10.40.0.0/26'
          delegations: [ { name: 'flex', properties: { serviceName: 'Microsoft.App/environments' } } ]
        }
      }
      {
        name: 'snet-pe'
        properties: { addressPrefix: '10.40.0.64/27', privateEndpointNetworkPolicies: 'Disabled' }
      }
    ]
  }
}

var peTargets = [
  { name: 'blob', id: st.id, group: 'blob', zone: 'privatelink.blob.${environment().suffixes.storage}' }
  { name: 'queue', id: st.id, group: 'queue', zone: 'privatelink.queue.${environment().suffixes.storage}' }
  { name: 'table', id: st.id, group: 'table', zone: 'privatelink.table.${environment().suffixes.storage}' }
  { name: 'kv', id: kv.id, group: 'vault', zone: 'privatelink.vaultcore.azure.net' }
]

resource dnsZones 'Microsoft.Network/privateDnsZones@2020-06-01' = [for p in peTargets: {
  name: p.zone
  location: 'global'
  tags: tags
}]

resource dnsLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = [for (p, i) in peTargets: {
  parent: dnsZones[i]
  name: 'link-${base}'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}]

resource pes 'Microsoft.Network/privateEndpoints@2023-11-01' = [for (p, i) in peTargets: {
  name: 'pe-${base}-${p.name}'
  location: location
  tags: tags
  properties: {
    subnet: { id: '${vnet.id}/subnets/snet-pe' }
    privateLinkServiceConnections: [ { name: p.name, properties: { privateLinkServiceId: p.id, groupIds: [ p.group ] } } ]
  }
}]

resource peDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = [for (p, i) in peTargets: {
  parent: pes[i]
  name: 'default'
  properties: { privateDnsZoneConfigs: [ { name: p.name, properties: { privateDnsZoneId: dnsZones[i].id } } ] }
}]

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-${base}'
  location: location
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  kind: 'functionapp'
  properties: { reserved: true }
}

resource func 'Microsoft.Web/sites@2023-12-01' = {
  name: 'func-${base}'
  location: location
  kind: 'functionapp,linux'
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: '${vnet.id}/subnets/snet-func'
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${st.properties.primaryEndpoints.blob}deployments'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: { maximumInstanceCount: 40, instanceMemoryMB: 2048 }
      runtime: { name: 'node', version: '22' }
    }
    siteConfig: {
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: st.name }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appi.properties.ConnectionString }
        { name: 'ServiceBusConnection__fullyQualifiedNamespace', value: '${sb.name}.servicebus.windows.net' }
        { name: 'STORAGE_TABLE_URL', value: st.properties.primaryEndpoints.table }
        { name: 'KEYVAULT_URL', value: kv.properties.vaultUri }
      ]
    }
  }
}

// --- RBAC for the Function App managed identity
var roles = {
  storageBlobDataOwner: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  storageQueueDataContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  sbDataOwner: '090c5cfd-751d-490a-894a-3ce6f1109419'
  kvSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  kvSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  kvCertificatesOfficer: 'a4417e6f-fecd-4de8-b567-7b0420556985'
  monitoringMetricsPublisher: '3913510d-42f4-4e42-8a64-420c390055eb'
}

resource raBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: st
  name: guid(st.id, func.id, roles.storageBlobDataOwner)
  properties: { principalId: func.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataOwner) }
}
resource raTable 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: st
  name: guid(st.id, func.id, roles.storageTableDataContributor)
  properties: { principalId: func.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageTableDataContributor) }
}
resource raQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: st
  name: guid(st.id, func.id, roles.storageQueueDataContributor)
  properties: { principalId: func.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageQueueDataContributor) }
}
resource raSb 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sb
  name: guid(sb.id, func.id, roles.sbDataOwner)
  properties: { principalId: func.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.sbDataOwner) }
}
resource raKv 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, func.id, roles.kvSecretsUser)
  properties: { principalId: func.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvSecretsUser) }
}
resource raAppi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: appi
  name: guid(appi.id, func.id, roles.monitoringMetricsPublisher)
  properties: { principalId: func.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.monitoringMetricsPublisher) }
}

// --- Admin: manage secrets + certificates in Key Vault, data access for local debugging
resource raAdminKvSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, adminObjectId, roles.kvSecretsOfficer)
  properties: { principalId: adminObjectId, principalType: 'User', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvSecretsOfficer) }
}
resource raAdminKvCerts 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, adminObjectId, roles.kvCertificatesOfficer)
  properties: { principalId: adminObjectId, principalType: 'User', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.kvCertificatesOfficer) }
}
resource raAdminTable 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: st
  name: guid(st.id, adminObjectId, roles.storageTableDataContributor)
  properties: { principalId: adminObjectId, principalType: 'User', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageTableDataContributor) }
}
resource raAdminSb 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sb
  name: guid(sb.id, adminObjectId, roles.sbDataOwner)
  properties: { principalId: adminObjectId, principalType: 'User', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.sbDataOwner) }
}

output functionAppName string = func.name
output functionHost string = func.properties.defaultHostName
output functionPrincipalId string = func.identity.principalId
output keyVaultName string = kv.name
output keyVaultUri string = kv.properties.vaultUri
output storageName string = st.name
output serviceBusNamespace string = sb.name
output appInsightsName string = appi.name
