import { Construct } from 'constructs';
import { Annotations, Match, Template } from '../../assertions';
import * as ec2 from '../../aws-ec2';
import * as iam from '../../aws-iam';
import { App, Stack } from '../../core';
import * as lambda from '../lib';
import { FunctionCapacityProvider } from '../lib/mixins';

const CAPACITY_PROVIDER_ARN = 'arn:aws:lambda:us-east-1:123456789012:capacity-provider:my-cp';

class TestConstruct extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);
  }
}

describe('Lambda Mixins', () => {
  let app: App;
  let stack: Stack;

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, 'TestStack');
  });

  describe('FunctionCapacityProvider', () => {
    function newFunction(id = 'MyFunction'): lambda.Function {
      return new lambda.Function(stack, id, {
        runtime: lambda.Runtime.NODEJS_LATEST,
        handler: 'index.handler',
        code: lambda.Code.fromInline('exports.handler = async () => {}'),
      });
    }

    function newCfnFunction(props: Partial<lambda.CfnFunctionProps> = {}): lambda.CfnFunction {
      const role = new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
      return new lambda.CfnFunction(stack, 'CfnFunction', {
        code: { zipFile: 'exports.handler = async () => {}' },
        role: role.roleArn,
        runtime: lambda.Runtime.NODEJS_LATEST.name,
        handler: 'index.handler',
        ...props,
      });
    }

    test('supports CfnFunction', () => {
      const cp = lambda.CapacityProvider.fromCapacityProviderArn(stack, 'CP', CAPACITY_PROVIDER_ARN);
      const mixin = new FunctionCapacityProvider(cp);

      expect(mixin.supports(newCfnFunction())).toBe(true);
    });

    test('does not support unrelated constructs', () => {
      const cp = lambda.CapacityProvider.fromCapacityProviderArn(stack, 'CP', CAPACITY_PROVIDER_ARN);
      const mixin = new FunctionCapacityProvider(cp);

      expect(mixin.supports(new TestConstruct(stack, 'Test'))).toBe(false);
      expect(mixin.supports(new lambda.CfnVersion(stack, 'Version', { functionName: 'my-function' }))).toBe(false);
    });

    test('attaches an imported capacity provider to an L2 function', () => {
      // GIVEN
      const cp = lambda.CapacityProvider.fromCapacityProviderArn(stack, 'CP', CAPACITY_PROVIDER_ARN);
      const fn = newFunction();

      // WHEN
      fn.with(new FunctionCapacityProvider(cp));

      // THEN
      Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
        CapacityProviderConfig: {
          LambdaManagedInstancesCapacityProviderConfig: {
            CapacityProviderArn: CAPACITY_PROVIDER_ARN,
          },
        },
        PublishToLatestPublished: Match.absent(),
        FunctionScalingConfig: Match.absent(),
      });
    });

    test('attaches a capacity provider imported by name', () => {
      // GIVEN
      const cp = lambda.CapacityProvider.fromCapacityProviderName(stack, 'CP', 'my-cp');
      const fn = newFunction();

      // WHEN
      fn.with(new FunctionCapacityProvider(cp));

      // THEN
      Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
        CapacityProviderConfig: {
          LambdaManagedInstancesCapacityProviderConfig: {
            CapacityProviderArn: {
              'Fn::Join': ['', [
                'arn:',
                { Ref: 'AWS::Partition' },
                ':lambda:',
                { Ref: 'AWS::Region' },
                ':',
                { Ref: 'AWS::AccountId' },
                ':capacity-provider:my-cp',
              ]],
            },
          },
        },
      });
    });

    test('attaches an L1 capacity provider to an L1 function with all options', () => {
      // GIVEN
      const vpc = new ec2.Vpc(stack, 'Vpc');
      const securityGroup = new ec2.SecurityGroup(stack, 'SecurityGroup', { vpc });
      const operatorRole = new iam.Role(stack, 'OperatorRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
      const cfnCapacityProvider = new lambda.CfnCapacityProvider(stack, 'CfnCapacityProvider', {
        vpcConfig: {
          subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
          securityGroupIds: [securityGroup.securityGroupId],
        },
        permissionsConfig: { capacityProviderOperatorRoleArn: operatorRole.roleArn },
      });

      // WHEN
      newCfnFunction().with(new FunctionCapacityProvider(cfnCapacityProvider, {
        perExecutionEnvironmentMaxConcurrency: 10,
        executionEnvironmentMemoryGiBPerVCpu: 4,
        publishToLatestPublished: true,
        latestPublishedScalingConfig: {
          minExecutionEnvironments: 1,
          maxExecutionEnvironments: 5,
        },
      }));

      // THEN
      Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
        PublishToLatestPublished: true,
        CapacityProviderConfig: {
          LambdaManagedInstancesCapacityProviderConfig: {
            CapacityProviderArn: { 'Fn::GetAtt': ['CfnCapacityProvider', 'Arn'] },
            PerExecutionEnvironmentMaxConcurrency: 10,
            ExecutionEnvironmentMemoryGiBPerVCpu: 4,
          },
        },
        FunctionScalingConfig: {
          MinExecutionEnvironments: 1,
          MaxExecutionEnvironments: 5,
        },
      });
    });

    test('does not overwrite existing publishToLatestPublished or functionScalingConfig when not provided', () => {
      // GIVEN
      const cp = lambda.CapacityProvider.fromCapacityProviderArn(stack, 'CP', CAPACITY_PROVIDER_ARN);
      const cfnFunction = newCfnFunction({
        publishToLatestPublished: true,
        functionScalingConfig: { minExecutionEnvironments: 2 },
      });

      // WHEN
      cfnFunction.with(new FunctionCapacityProvider(cp));

      // THEN
      Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
        PublishToLatestPublished: true,
        FunctionScalingConfig: { MinExecutionEnvironments: 2 },
        CapacityProviderConfig: {
          LambdaManagedInstancesCapacityProviderConfig: {
            CapacityProviderArn: CAPACITY_PROVIDER_ARN,
          },
        },
      });
    });

    test('replaces an existing capacity provider configuration', () => {
      // GIVEN
      const first = lambda.CapacityProvider.fromCapacityProviderArn(stack, 'First', CAPACITY_PROVIDER_ARN);
      const second = lambda.CapacityProvider.fromCapacityProviderArn(stack, 'Second', 'arn:aws:lambda:us-east-1:123456789012:capacity-provider:other-cp');
      const fn = newFunction();

      // WHEN
      fn.with(new FunctionCapacityProvider(first, { perExecutionEnvironmentMaxConcurrency: 10 }));
      fn.with(new FunctionCapacityProvider(second));

      // THEN
      Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
        CapacityProviderConfig: {
          LambdaManagedInstancesCapacityProviderConfig: Match.objectEquals({
            CapacityProviderArn: 'arn:aws:lambda:us-east-1:123456789012:capacity-provider:other-cp',
          }),
        },
      });
    });

    test('adds an info annotation to the function', () => {
      // GIVEN
      const cp = lambda.CapacityProvider.fromCapacityProviderArn(stack, 'CP', CAPACITY_PROVIDER_ARN);
      const fn = newFunction();

      // WHEN
      fn.with(new FunctionCapacityProvider(cp));

      // THEN
      Annotations.fromStack(stack).hasInfo('/TestStack/MyFunction/Resource',
        Match.stringLikeRegexp('Capacity provider configuration cannot be removed from a function, only modified.'));
    });

    test('produces the same functions as CapacityProvider.addFunction', () => {
      const options: lambda.CapacityProviderFunctionOptions = {
        perExecutionEnvironmentMaxConcurrency: 10,
        publishToLatestPublished: true,
        latestPublishedScalingConfig: { minExecutionEnvironments: 1 },
      };

      function synthFunctions(attach: (cp: lambda.CapacityProvider, fn: lambda.Function) => void) {
        const s = new Stack(new App(), 'Stack');
        const vpc = new ec2.Vpc(s, 'Vpc');
        const cp = new lambda.CapacityProvider(s, 'CapacityProvider', {
          subnets: vpc.privateSubnets,
          securityGroups: [new ec2.SecurityGroup(s, 'SecurityGroup', { vpc })],
        });
        const fn = new lambda.Function(s, 'MyFunction', {
          runtime: lambda.Runtime.NODEJS_LATEST,
          handler: 'index.handler',
          code: lambda.Code.fromInline('exports.handler = async () => {}'),
        });
        attach(cp, fn);
        return Template.fromStack(s).findResources('AWS::Lambda::Function');
      }

      const viaMixin = synthFunctions((cp, fn) => fn.with(new FunctionCapacityProvider(cp, options)));
      const viaMethod = synthFunctions((cp, fn) => cp.addFunction(fn, options));

      expect(viaMixin).toEqual(viaMethod);
      expect(Object.values(viaMethod)[0].Properties.CapacityProviderConfig).toBeDefined();
    });

    test.each([
      [{ minExecutionEnvironments: -1 }, 'minExecutionEnvironments must be between 0 and 15000, but was -1'],
      [{ minExecutionEnvironments: 15001 }, 'minExecutionEnvironments must be between 0 and 15000, but was 15001'],
      [{ maxExecutionEnvironments: -1 }, 'maxExecutionEnvironments must be between 0 and 15000, but was -1'],
      [{ maxExecutionEnvironments: 15001 }, 'maxExecutionEnvironments must be between 0 and 15000, but was 15001'],
      [{ minExecutionEnvironments: 5, maxExecutionEnvironments: 1 }, 'minExecutionEnvironments must be less than or equal to maxExecutionEnvironments'],
    ])('fails for invalid latestPublishedScalingConfig %j', (latestPublishedScalingConfig, message) => {
      const cp = lambda.CapacityProvider.fromCapacityProviderArn(stack, 'CP', CAPACITY_PROVIDER_ARN);

      expect(() => new FunctionCapacityProvider(cp, { latestPublishedScalingConfig })).toThrow(message);
    });
  });
});
