import { randomUUID } from 'crypto';
import { SignedXml } from 'xml-crypto';
import { ISecurity } from '../types';

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60000);
}

function dateStringForSOAP(date: Date): string {
  return date.getUTCFullYear() + '-' + ('0' + (date.getUTCMonth() + 1)).slice(-2) + '-' +
    ('0' + date.getUTCDate()).slice(-2) + 'T' + ('0' + date.getUTCHours()).slice(-2) + ':' +
    ('0' + date.getUTCMinutes()).slice(-2) + ':' + ('0' + date.getUTCSeconds()).slice(-2) + 'Z';
}

function generateCreated(): string {
  return dateStringForSOAP(new Date());
}

function generateExpires(): string {
  return dateStringForSOAP(addMinutes(new Date(), 10));
}

function insertStr(src: string, dst: string, pos: number): string {
  return [dst.slice(0, pos), src, dst.slice(pos)].join('');
}

function generateId(): string {
  return randomUUID().replace(/-/gm, '');
}

function resolvePlaceholderInReferences(references: any[], bodyXpath: string) {
  for (const ref of references) {
    if (ref.xpath === bodyXpathPlaceholder) {
      ref.xpath = bodyXpath;
    }
  }
}

const oasisBaseUri = 'http://docs.oasis-open.org/wss/2004/01';
const bodyXpathPlaceholder = '[[bodyXpath]]';

export interface IWSSecurityCertOptions {
  hasTimeStamp?: boolean;
  signatureTransformations?: string[];
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
  additionalReferences?: string[];
  signerOptions?: IXmlSignerOptions;
  excludeReferencesFromSigning?: string[];
}

export interface IXmlSignerOptions {
  prefix?: string;
  attrs?: { [key: string]: string };
  existingPrefixes?: { [key: string]: string };
  idMode?: 'wssecurity';
}

export class WSSecurityCert implements ISecurity {
  private publicP12PEM: string;
  private signer: any;
  private signerOptions: IXmlSignerOptions = {};
  private x509Id: string;
  private hasTimeStamp: boolean;
  private signatureTransformations: string[];
  private created: string;
  private expires: string;
  private additionalReferences: string[] = [];
  private excludeReferencesFromSigning: string[] = [];

  constructor(privatePEM: any, publicP12PEM: any, password: any, options: IWSSecurityCertOptions = {}) {
    this.publicP12PEM = publicP12PEM.toString()
      .replace('-----BEGIN CERTIFICATE-----', '')
      .replace('-----END CERTIFICATE-----', '')
      .replace(/(\r\n|\n|\r)/gm, '');

    this.signer = new SignedXml({
      idMode: options?.signerOptions?.idMode,
      signatureAlgorithm: options?.signatureAlgorithm,
    });

    this.signer.digestAlgorithm = options.digestAlgorithm ?? 'http://www.w3.org/2001/04/xmlenc#sha256';
    if (options.signatureAlgorithm === 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256') {
      this.signer.signatureAlgorithm = options.signatureAlgorithm;
      this.signer.addReference({
        xpath: bodyXpathPlaceholder,
        transforms: ['http://www.w3.org/2001/10/xml-exc-c14n#'],
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      });
    }

    if (!options.signatureAlgorithm) {
      this.signer.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
    }

    this.signer.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';

    if (options.additionalReferences && options.additionalReferences.length > 0) {
      this.additionalReferences = options.additionalReferences;
    }

    if (options.excludeReferencesFromSigning && options.excludeReferencesFromSigning.length > 0) {
      this.excludeReferencesFromSigning = options.excludeReferencesFromSigning;
    }

    if (options.signerOptions) {
      const { signerOptions } = options;
      this.signerOptions = signerOptions;
      if (!this.signerOptions.existingPrefixes) {
        this.signerOptions.existingPrefixes = {};
      }
      if (this.signerOptions.existingPrefixes && !this.signerOptions.existingPrefixes.wsse) {
        this.signerOptions.existingPrefixes.wsse = `${oasisBaseUri}/oasis-200401-wss-wssecurity-secext-1.0.xsd`;
      }
    } else {
      this.signerOptions = { existingPrefixes: { wsse: `${oasisBaseUri}/oasis-200401-wss-wssecurity-secext-1.0.xsd` } };
    }

    this.signer.privateKey = {
      key: privatePEM,
      passphrase: password,
    };
    this.x509Id = `x509-${generateId()}`;
    this.hasTimeStamp = typeof options.hasTimeStamp === 'undefined' ? true : !!options.hasTimeStamp;
    this.signatureTransformations = Array.isArray(options.signatureTransformations) ? options.signatureTransformations
      : ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'];

    this.signer.getKeyInfoContent = (key) => {
      return `<wsse:SecurityTokenReference>` +
        `<wsse:Reference URI="#${this.x509Id}" ValueType="${oasisBaseUri}/oasis-200401-wss-x509-token-profile-1.0#X509v3"/>` +
        `</wsse:SecurityTokenReference>`;
    };
  }

  public postProcess(xml: string, envelopeKey: string) {
    this.created = generateCreated();
    this.expires = generateExpires();

    let timestampStr = '';
    if (this.hasTimeStamp) {
      timestampStr =
        `<Timestamp xmlns="${oasisBaseUri}/oasis-200401-wss-wssecurity-utility-1.0.xsd">` +
        `<Created>${this.created}</Created>` +
        `<Expires>${this.expires}</Expires>` +
        `</Timestamp>`;
    }

    const binarySecurityToken = `<wsse:BinarySecurityToken ` +
      `EncodingType="${oasisBaseUri}/oasis-200401-wss-soap-message-security-1.0#Base64Binary" ` +
      `ValueType="${oasisBaseUri}/oasis-200401-wss-x509-token-profile-1.0#X509v3" ` +
      `wsu:Id="${this.x509Id}">${this.publicP12PEM}</wsse:BinarySecurityToken>` +
      timestampStr;

    let xmlWithSec: string;
    const secExt = `xmlns:wsse="${oasisBaseUri}/oasis-200401-wss-wssecurity-secext-1.0.xsd"`;
    const secUtility = `xmlns:wsu="${oasisBaseUri}/oasis-200401-wss-wssecurity-utility-1.0.xsd"`;
    const endOfSecurityHeader = xml.indexOf('</wsse:Security>');
    if (endOfSecurityHeader > -1) {
      const securityHeaderRegexp = /<wsse:Security( [^>]*)?>/;
      const match = xml.match(securityHeaderRegexp);
      let insertHeaderAttributes = '';
      if (!match[0].includes(` ${envelopeKey}:mustUnderstand="`)) {
        insertHeaderAttributes += `${envelopeKey}:mustUnderstand="1" `;
      }
      if (!match[0].includes(secExt.substring(0, secExt.indexOf('=')))) {
        insertHeaderAttributes += `${secExt} `;
      }
      if (!match[0].includes(secUtility.substring(0, secExt.indexOf('=')))) {
        insertHeaderAttributes += `${secUtility} `;
      }
      const headerMarker = '<wsse:Security ';
      const startOfSecurityHeader = xml.indexOf(headerMarker);
      xml = insertStr(binarySecurityToken, xml, endOfSecurityHeader);
      xmlWithSec = insertStr(insertHeaderAttributes, xml, startOfSecurityHeader + headerMarker.length);
    } else {
      const secHeader =
        `<wsse:Security ${secExt} ` +
        `${secUtility} ` +
        `${envelopeKey}:mustUnderstand="1">` +
        binarySecurityToken +
        `</wsse:Security>`;

      xmlWithSec = insertStr(secHeader, xml, xml.indexOf(`</${envelopeKey}:Header>`));
    }

    const references = this.signatureTransformations;

    const bodyXpath = `//*[name(.)='${envelopeKey}:Body']`;
    resolvePlaceholderInReferences(this.signer.references, bodyXpath);

    if (!this.excludeReferencesFromSigning.some((ref) => ref === 'Body') && !(this.signer.references.filter((ref: { xpath: string; }) => (ref.xpath === bodyXpath)).length > 0)) {
        this.signer.addReference({ xpath: bodyXpath, transforms: references, digestAlgorithm: this.signer.digestAlgorithm });
    }

    for (const name of this.additionalReferences) {
      const xpath = `//*[name(.)='${name}']`;
      if (!this.excludeReferencesFromSigning.some((ref) => ref === name) && !(this.signer.references.filter((ref: { xpath: string; }) => (ref.xpath === xpath)).length > 0)) {
        this.signer.addReference({ xpath: xpath, transforms: references, digestAlgorithm: this.signer.digestAlgorithm });
      }
    }

    const timestampXpath = `//*[name(.)='wsse:Security']/*[local-name(.)='Timestamp']`;
    if (!this.excludeReferencesFromSigning.some((ref) => ref === 'Timestamp') && this.hasTimeStamp && !(this.signer.references.filter((ref: { xpath: string; }) => (ref.xpath === timestampXpath)).length > 0)) {
      this.signer.addReference({ xpath: timestampXpath, transforms: references, digestAlgorithm: this.signer.digestAlgorithm });
    }

    this.signer.computeSignature(xmlWithSec, this.signerOptions);

    const originalXmlWithIds = this.signer.getOriginalXmlWithIds();
    const signatureXml = this.signer.getSignatureXml();
    return insertStr(signatureXml, originalXmlWithIds, originalXmlWithIds.indexOf('</wsse:Security>'));
  }
}
