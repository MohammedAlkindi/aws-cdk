import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cdk from 'aws-cdk-lib/core';
import * as integ from '@aws-cdk/integ-tests-alpha';

const app = new cdk.App({
  postCliContext: {
    '@aws-cdk/aws-lambda:useCdkManagedLogGroup': false,
  },
});
const stack = new cdk.Stack(app, 'FunctionCapacityProviderMixinStack');

const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2 });
const securityGroup = new ec2.SecurityGroup(stack, 'SecurityGroup', { vpc });
const operatorRole = new iam.Role(stack, 'OperatorRole', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AWSLambdaManagedEC2ResourceOperator')],
});

const cfnCapacityProvider = new lambda.CfnCapacityProvider(stack, 'CapacityProvider', {
  vpcConfig: {
    subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
    securityGroupIds: [securityGroup.securityGroupId],
  },
  permissionsConfig: {
    capacityProviderOperatorRoleArn: operatorRole.roleArn,
  },
});

// L2 function attached to a capacity provider imported by ARN
const importedCapacityProvider = lambda.CapacityProvider.fromCapacityProviderArn(stack, 'ImportedCapacityProvider', cfnCapacityProvider.attrArn);

new lambda.Function(stack, 'Function', {
  runtime: lambda.Runtime.NODEJS_LATEST,
  handler: 'index.handler',
  code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 });'),
}).with(new lambda.mixins.FunctionCapacityProvider(importedCapacityProvider, {
  perExecutionEnvironmentMaxConcurrency: 10,
  executionEnvironmentMemoryGiBPerVCpu: 4,
}));

// L1 function attached to the L1 capacity provider
const cfnFunctionRole = new iam.Role(stack, 'CfnFunctionRole', {
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
});

new lambda.CfnFunction(stack, 'CfnFunction', {
  runtime: lambda.Runtime.NODEJS_LATEST.name,
  handler: 'index.handler',
  code: { zipFile: 'exports.handler = async () => ({ statusCode: 200 });' },
  role: cfnFunctionRole.roleArn,
}).with(new lambda.mixins.FunctionCapacityProvider(cfnCapacityProvider, {
  latestPublishedScalingConfig: {
    minExecutionEnvironments: 3,
    maxExecutionEnvironments: 6,
  },
}));

new integ.IntegTest(app, 'FunctionCapacityProviderMixinTest', {
  testCases: [stack],
  regions: ['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eu-central-1', 'eu-north-1', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1'],
});
