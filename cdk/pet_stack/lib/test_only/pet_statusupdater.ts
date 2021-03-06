import * as cdk from '@aws-cdk/core';
import * as lambda from '@aws-cdk/aws-lambda';
import * as apigw from '@aws-cdk/aws-apigateway';
import * as iam from '@aws-cdk/aws-iam';
import { removeListener } from 'cluster';
import { Method } from '@aws-cdk/aws-apigateway';


export class PetStatusUpdater extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    var iamrole = new iam.Role(this, 'lambdaexecutionrole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromManagedPolicyArn(this, 'first', 'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess'),
      iam.ManagedPolicy.fromManagedPolicyArn(this, 'second', 'arn:aws:iam::aws:policy/AWSLambdaFullAccess')],
      roleName: 'PetStatusUpdaterRole'
    });

    var petstatusupdater = new lambda.Function(this, 'lambdafn', {
      runtime: lambda.Runtime.NODEJS_12_X,    // execution environment
      code: lambda.Code.fromAsset('../../petstatusupdater/function.zip'),  // code loaded from "lambda" directory
      handler: 'index.handler',
      tracing: lambda.Tracing.ACTIVE,
      role: iamrole,
      description: 'Update Pet availability status',
      environment:
      {
        "TABLE_NAME": "petadoptions"
      }
    });

    //defines an API Gateway REST API resource backed by our "petstatusupdater" function.
    const apigateway = new apigw.LambdaRestApi(this, 'PetAdoptionStatusUpdater', {
      handler: petstatusupdater,
      proxy: true,
      endpointConfiguration: {
        types: [apigw.EndpointType.REGIONAL]
      }, deployOptions: {
        tracingEnabled: true,
        stageName: 'prod'
      }, options: { defaultMethodOptions: { methodResponses: [] } }
      //defaultIntegration: new apigw.Integration({ integrationHttpMethod: 'PUT', type: apigw.IntegrationType.AWS })
    });

  }
}